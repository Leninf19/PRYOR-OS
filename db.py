"""
Shared SQLite access layer for the review pipeline.

dashboard/reviews.db is the source of truth (committed to git like
reviews.csv was before it). This module owns the schema and the
upsert/revision/deletion-detection logic so auto_update.py, the one-off
migration script, and future pipeline stages (validate.py,
refresh_analytics.py, export_chunks.py) all go through the same path
instead of re-implementing dedup/diff logic per script.
"""
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "dashboard" / "reviews.db"

# A review re-appearing missing for less than this long is treated as
# scraper noise (a stalled scroll, a transient DOM miss), not a deletion.
DELETION_GRACE = timedelta(hours=12)

_PLACEID_RE = re.compile(r'placeid=([^&]+)')
_MAPS_ID_RE = re.compile(r'/reviews/([^/?]+)')

# Mirrors dashboard/src/utils/dataUtils.js's BRANDS/getBrand() -- kept here as
# the single Python-side copy so auto_update.py and migrate_csv_to_sqlite.py
# don't each maintain their own.
BRANDS = ['Los Tres Amigos', 'Los Tres Mex Grill', 'Mi Lindo San Blas', 'Rio Luna', 'Casa Tequila']


def get_brand(name: str) -> str:
    for b in BRANDS:
        if name.startswith(b):
            return b
    return 'Other'

SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT UNIQUE NOT NULL,
    city          TEXT,
    brand         TEXT,
    search_query  TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id          INTEGER NOT NULL REFERENCES locations(id),
    canonical_review_id  TEXT,
    dedup_key            TEXT NOT NULL UNIQUE,
    reviewer_name        TEXT,
    review_date          TEXT,
    star_rating          INTEGER,
    review_text          TEXT,
    owner_response       TEXT,
    review_url           TEXT,
    first_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at         TEXT,
    missing_since        TEXT,
    is_deleted           INTEGER NOT NULL DEFAULT 0,
    deleted_detected_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_location ON reviews(location_id);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);

CREATE TABLE IF NOT EXISTS review_revisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id     INTEGER NOT NULL REFERENCES reviews(id),
    changed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    field_changed TEXT NOT NULL,
    old_value     TEXT,
    new_value     TEXT
);

CREATE TABLE IF NOT EXISTS scraper_runs (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at             TEXT NOT NULL,
    finished_at            TEXT,
    mode                   TEXT,
    status                 TEXT,
    locations_attempted    INTEGER DEFAULT 0,
    locations_succeeded    INTEGER DEFAULT 0,
    locations_failed       INTEGER DEFAULT 0,
    new_reviews_count      INTEGER DEFAULT 0,
    edited_reviews_count   INTEGER DEFAULT 0,
    deleted_reviews_count  INTEGER DEFAULT 0,
    error_summary          TEXT
);

CREATE TABLE IF NOT EXISTS scraper_run_locations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL REFERENCES scraper_runs(id),
    location_id    INTEGER NOT NULL REFERENCES locations(id),
    status         TEXT,
    reviews_found  INTEGER DEFAULT 0,
    reviews_new    INTEGER DEFAULT 0,
    error_message  TEXT,
    duration_ms    INTEGER
);

CREATE TABLE IF NOT EXISTS validation_flags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id    INTEGER REFERENCES reviews(id),
    location_id  INTEGER REFERENCES locations(id),
    flag_type    TEXT NOT NULL,
    detail       TEXT,
    detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS analytics_cache (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key    TEXT UNIQUE NOT NULL,
    computed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    payload      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications_log (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at              TEXT NOT NULL DEFAULT (datetime('now')),
    notification_type    TEXT NOT NULL,
    recipient            TEXT,
    subject              TEXT,
    related_review_id    INTEGER REFERENCES reviews(id),
    related_location_id  INTEGER REFERENCES locations(id)
);
"""


def canonical_review_id(url: str):
    if not url:
        return None
    m = _PLACEID_RE.search(url)
    if m:
        return m.group(1)
    m = _MAPS_ID_RE.search(url)
    if m:
        return m.group(1)
    return None


def dedup_key(location_name: str, row: dict) -> str:
    # gbp_review_name (the Google Business Profile API's own resource path) is
    # the strongest possible identity when present -- preferred over the
    # Maps-scrape-derived canonical_review_id, which doesn't exist for rows
    # sourced from the API sync rather than the scraper.
    gbp_name = row.get("gbp_review_name")
    if gbp_name:
        return gbp_name
    rid = canonical_review_id(row.get("review_url", ""))
    if rid:
        return rid
    return "|".join([location_name, row.get("reviewer_name", ""),
                      row.get("review_date", ""), str(row.get("star_rating", ""))])


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection):
    conn.executescript(SCHEMA)
    _migrate_schema(conn)
    conn.commit()


def ensure_validation_flags_open_identity_index(conn: sqlite3.Connection) -> bool:
    """At most one OPEN row per (review_id, location_id, flag_type). Uses
    COALESCE(review_id, 0) rather than the bare column because SQLite (like
    standard SQL generally) never treats two NULLs as equal for uniqueness
    purposes -- a plain index on the raw columns would silently fail to
    deduplicate stale_location/unverified_location (both always have
    review_id IS NULL), only ever protecting the five review-scoped types.
    review_id is an AUTOINCREMENT PRIMARY KEY starting at 1, so 0 can never
    collide with a real id.

    Returns True if the index exists after this call, False if a duplicate
    open flag currently blocks it. Only sqlite3.IntegrityError is caught --
    that's the one specific, expected failure mode (a uniqueness violation);
    anything else (a malformed statement, a missing table, a locked
    database) is a real bug and must propagate, not be swallowed here.

    This is deliberately callable from two places with different reactions
    to a False result: _migrate_schema() calls it before any business logic
    has run, so a pre-existing violation is expected and only warned about.
    validate.run() calls it again immediately after its own self-healing
    completes, where a False result means self-healing itself is broken and
    must raise, not silently leave the invariant unenforced."""
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_validation_flags_open_identity "
            "ON validation_flags(COALESCE(review_id, 0), location_id, flag_type) "
            "WHERE resolved_at IS NULL"
        )
        return True
    except sqlite3.IntegrityError:
        return False


# Bumped whenever a migration is added to the list below -- purely an
# observability marker (`PRAGMA user_version`), not a gate: every migration
# is still individually idempotent via the try/except pattern, so this
# doesn't control which migrations run. It just lets you tell at a glance,
# from the DB file alone, whether it's seen the latest migration batch --
# `sqlite3 reviews.db "PRAGMA user_version"` -- without reading this file.
SCHEMA_VERSION = 18


def _migrate_schema(conn: sqlite3.Connection):
    """Apply additive schema migrations that can't go in CREATE TABLE IF NOT EXISTS."""
    migrations = [
        "ALTER TABLE locations ADD COLUMN maps_url TEXT",
        "ALTER TABLE reviews ADD COLUMN ai_sentiment TEXT",
        "ALTER TABLE reviews ADD COLUMN ai_sentiment_reason TEXT",
        "ALTER TABLE reviews ADD COLUMN ai_priority TEXT",
        "ALTER TABLE reviews ADD COLUMN ai_hash TEXT",
        # Google Business Profile API integration -- populated by gbp_sync.py/
        # gbp_import.py, left NULL for scraper-sourced rows. gbp_review_name is
        # the API's own resource path (accounts/*/locations/*/reviews/*), the
        # strongest possible identity -- see dedup_key(). gbp_update_time /
        # gbp_reply_update_time are Google's own timestamps (the scraper never
        # captured a reply date at all).
        "ALTER TABLE locations ADD COLUMN gbp_account_name TEXT",
        "ALTER TABLE locations ADD COLUMN gbp_location_name TEXT",
        "ALTER TABLE locations ADD COLUMN gbp_verification_status TEXT",
        "ALTER TABLE locations ADD COLUMN gbp_last_synced_at TEXT",
        "ALTER TABLE reviews ADD COLUMN gbp_review_name TEXT",
        "ALTER TABLE reviews ADD COLUMN gbp_update_time TEXT",
        "ALTER TABLE reviews ADD COLUMN gbp_reply_update_time TEXT",
        "ALTER TABLE reviews ADD COLUMN gbp_language_code TEXT",
        # Distinguishes a global failure (couldn't even discover locations --
        # e.g. a Google API quota/auth error) from a per-location scrape
        # failure, so notify.py can pick the right failure-alert template
        # instead of inferring it from zeroed location counters. NULL for
        # every pre-existing row and for normal per-location failures --
        # both keep using the original (unrelated, unchanged) alert wording.
        "ALTER TABLE scraper_runs ADD COLUMN failure_stage TEXT",
        # Phase 3 Milestone 1 (sync framework foundation): `provider` names
        # which Provider implementation wrote this run explicitly ('gbp' |
        # 'scraper' | 'mock') -- never inferred from `mode`, which keeps its
        # exact existing values/meaning ('local'/'cloud'/'api_sync') for
        # every current reader (export_chunks.py's `WHERE mode='api_sync'`
        # filtering, ScraperStatus.jsx's `run.mode` display). NULL for every
        # historical row written before this migration.
        "ALTER TABLE scraper_runs ADD COLUMN provider TEXT",
        # How many attempts retry.py's backoff used before this location's
        # fetch succeeded or gave up; 1 = no retry needed. Default 1 (not
        # NULL) since every pre-existing row represents exactly one
        # (unretried) attempt under the prior implementation.
        "ALTER TABLE scraper_run_locations ADD COLUMN attempt_count INTEGER DEFAULT 1",
        # Machine-readable failure classification, parallel to the existing
        # free-text error_message (not a replacement): '429'|'403'|'404'|
        # '5xx'|'network'|'blocked'|NULL.
        "ALTER TABLE scraper_run_locations ADD COLUMN provider_error_code TEXT",
        # Restaurant bad-review email workflow (recovery-audit milestone):
        # the authoritative location-to-contact-email mapping. NULL
        # contact_email (every pre-existing row, and any location that has
        # never had a contact entered) means "not configured" -- the send
        # feature must disable sending for that location rather than ever
        # inventing/guessing a recipient. contact_active is a separate flag
        # from locations.is_active: a location can be actively operating
        # while its on-file contact is temporarily stale (staff turnover)
        # without touching the location's own active status.
        "ALTER TABLE locations ADD COLUMN contact_email TEXT",
        "ALTER TABLE locations ADD COLUMN contact_name TEXT",
        "ALTER TABLE locations ADD COLUMN contact_active INTEGER NOT NULL DEFAULT 1",
        # Scraper-run-lifecycle audit: lets a stuck/failed/timed-out row be
        # traced straight back to the actual GitHub Actions run log
        # (https://github.com/<repo>/actions/runs/<workflow_run_id>) instead
        # of just a started_at timestamp a human has to manually correlate.
        # Populated from the GITHUB_RUN_ID env var GitHub Actions sets
        # automatically; NULL for local/manual runs and every historical row
        # written before this column existed.
        "ALTER TABLE scraper_runs ADD COLUMN workflow_run_id TEXT",
        # Lets a notification be tied to one specific scraper_runs row (e.g.
        # health_check.py's stuck-run alert) so dedup can be scoped to "have
        # we already alerted about THIS run" rather than "did any stuck-run
        # alert fire recently" -- the latter either suppressed a genuinely
        # new stuck run or re-alerted forever on the same permanently-open
        # one, depending on timing (the run #159 recurring-alert bug).
        "ALTER TABLE notifications_log ADD COLUMN related_run_id INTEGER REFERENCES scraper_runs(id)",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # Column already exists

    # Must run after the ALTER TABLEs above -- the column has to exist first.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_gbp_review_name "
        "ON reviews(gbp_review_name) WHERE gbp_review_name IS NOT NULL"
    )

    # Defense in depth for validate.py's flag-identity invariant (schema v18).
    # This runs before any business logic has had a chance to self-heal
    # pre-existing data, so a pre-existing violation here is expected and
    # must never crash the whole pipeline -- loudly warn instead. validate.py
    # re-attempts the same call AFTER its own self-healing runs, and raises
    # loudly if it's still blocked at that point -- see validate.run().
    if not ensure_validation_flags_open_identity_index(conn):
        print("::warning::db.py: could not create idx_validation_flags_open_identity yet -- "
              "a pre-existing duplicate-open validation flag violates it. "
              "validate.py's own self-healing will resolve this on its next run; "
              "the index will be created automatically once it does.")

    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


# Same shape as dashboard/api/_lib/accounts.js's account-email validation --
# kept as a literal duplicate (not a shared module) for the same reason
# db.py's own BRANDS list duplicates dashboard/src/utils/dataUtils.js's:
# there is no Python/JS shared-module boundary in this repo.
_CONTACT_EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')


def set_location_contact(conn, location_id: int, email: str, name: str | None = None, active: bool = True) -> None:
    """Administrative helper for populating the restaurant bad-review email
    workflow's location-to-contact mapping (recovery-audit milestone). Never
    called by any scheduled pipeline stage -- a one-off action run by hand
    (see set_location_contacts.py) or from a trusted admin script, never
    from anything network-facing. Validates the email shape so a typo fails
    loudly here rather than silently reaching export_chunks.py or the send
    endpoint with a garbage recipient."""
    if not _CONTACT_EMAIL_RE.match((email or "").strip()):
        raise ValueError(f"invalid contact email for location {location_id}: {email!r}")
    row = conn.execute("SELECT id FROM locations WHERE id = ?", (location_id,)).fetchone()
    if not row:
        raise ValueError(f"no location with id {location_id}")
    conn.execute(
        "UPDATE locations SET contact_email = ?, contact_name = ?, contact_active = ? WHERE id = ?",
        (email.strip(), (name.strip() if name else None), 1 if active else 0, location_id),
    )


def review_content_hash(review_text: str, star_rating) -> str:
    """Hash of the fields that drive AI classification -- used to detect a
    review that needs (re)classification, e.g. new reviews or edited text."""
    import hashlib
    raw = f"{(review_text or '').strip()}|{star_rating}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]


def get_reviews_needing_classification(conn, limit: int | None = None) -> list:
    """Reviews whose ai_hash doesn't match their current content -- i.e. never
    classified, or edited since the last classification pass."""
    rows = conn.execute(
        """SELECT id, review_text, star_rating, ai_hash FROM reviews
           WHERE is_deleted = 0 AND review_text IS NOT NULL AND review_text != ''"""
    ).fetchall()
    needing = [dict(r) for r in rows if review_content_hash(r["review_text"], r["star_rating"]) != (r["ai_hash"] or "")]
    needing.sort(key=lambda r: r["id"])
    return needing[:limit] if limit else needing


def save_ai_classification(conn, review_id: int, sentiment: str, reason: str, priority: str, content_hash: str) -> None:
    conn.execute(
        """UPDATE reviews SET ai_sentiment = ?, ai_sentiment_reason = ?, ai_priority = ?, ai_hash = ?
           WHERE id = ?""",
        (sentiment, reason, priority, content_hash, review_id),
    )


def get_or_create_location(conn, name: str, city: str = "", brand: str = "", search_query: str = "", maps_url: str = "") -> int:
    row = conn.execute("SELECT id FROM locations WHERE name = ?", (name,)).fetchone()
    if row:
        if maps_url:
            conn.execute(
                "UPDATE locations SET city = ?, brand = ?, search_query = ?, maps_url = ? WHERE id = ?",
                (city, brand, search_query, maps_url, row["id"]),
            )
        else:
            conn.execute(
                "UPDATE locations SET city = ?, brand = ?, search_query = ? WHERE id = ?",
                (city, brand, search_query, row["id"]),
            )
        return row["id"]
    cur = conn.execute(
        "INSERT INTO locations (name, city, brand, search_query, maps_url) VALUES (?, ?, ?, ?, ?)",
        (name, city, brand, search_query, maps_url or None),
    )
    return cur.lastrowid


def link_review_to_gbp(conn, review_id: int, gbp_review_name: str, gbp_update_time: str = None,
                        gbp_reply_update_time: str = None, gbp_language_code: str = None) -> None:
    """Attaches Google API identity to an ALREADY-KNOWN existing review row by
    its own id -- used by gbp_import.py's reconciliation pass once it has
    matched a scraped row to an API review, since routing that through
    upsert_review()/dedup_key() would look the row up by gbp_review_name
    (which doesn't exist on it yet) and insert a duplicate instead of
    updating the row that was actually matched.

    Invariant this function exists to uphold: whenever gbp_review_name is
    non-null on a row, dedup_key MUST equal it -- gbp_review_name is the
    canonical identity for any GBP-linked review, and dedup_key is only ever
    an independently-meaningful value for rows that don't have one yet.
    Both columns are set in the same UPDATE statement so the row can never
    be observed in a state where they've diverged (the exact production
    incident this invariant was added to prevent: a row linked here without
    also updating dedup_key looked, to a later upsert_review() call, like a
    brand new review sharing another row's gbp_review_name -- a duplicate
    insert attempt that violated the partial UNIQUE index)."""
    conn.execute(
        """UPDATE reviews SET gbp_review_name = ?, dedup_key = ?, gbp_update_time = ?,
           gbp_reply_update_time = ?, gbp_language_code = ? WHERE id = ?""",
        (gbp_review_name, gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code, review_id),
    )


def set_location_gbp_info(conn, location_id: int, gbp_account_name: str,
                           gbp_location_name: str, gbp_verification_status: str, now: str) -> None:
    """Records the Google Business Profile API resource identity for a location,
    plus a sync timestamp -- called once per location per gbp_sync.py run."""
    conn.execute(
        """UPDATE locations SET gbp_account_name = ?, gbp_location_name = ?,
           gbp_verification_status = ?, gbp_last_synced_at = ? WHERE id = ?""",
        (gbp_account_name, gbp_location_name, gbp_verification_status, now, location_id),
    )


def get_location_by_gbp_name(conn, gbp_location_name: str):
    """Looks up a location previously linked via set_location_gbp_info() by its
    Google API resource name -- lets gbp_sync.py map an API location straight
    back to our internal location_id without re-doing name matching."""
    return conn.execute(
        "SELECT * FROM locations WHERE gbp_location_name = ?", (gbp_location_name,)
    ).fetchone()


def upsert_review(conn, location_id: int, location_name: str, row: dict, now: str) -> str:
    """Insert a new review or update an existing one. Returns 'new', 'edited', or 'unchanged'.

    `row` may optionally carry gbp_review_name / gbp_update_time / gbp_reply_update_time /
    gbp_language_code -- populated by the Google Business Profile API sync (gbp_sync.py /
    gbp_import.py), always absent (None) for scraper-sourced rows from auto_update.py.
    When present, gbp_review_name is the canonical identity (see link_review_to_gbp()'s
    docstring for the invariant this upholds) and gbp_update_time becomes an authoritative
    edit signal straight from Google, on top of the existing text/rating/response
    comparison below.

    Matching order for a row with a gbp_review_name: look it up BY gbp_review_name
    directly, first -- never rely on a freshly-computed dedup_key alone to decide
    whether this review already exists. A row can legitimately have a stale dedup_key
    (e.g. one attached via link_review_to_gbp() before that function's own dedup_key
    fix shipped, or any other historical inconsistency) while its gbp_review_name is
    already correct and authoritative; computing dedup_key() first and searching by
    that would miss such a row entirely and attempt a duplicate insert, tripping the
    partial UNIQUE index on gbp_review_name instead of finding the real match. Rows
    without a gbp_review_name keep the exact original dedup_key-based lookup (canonical
    scraped review ID, else the composite fallback) -- unchanged, since the scraper
    remains a fallback provider with no other identity to match by.
    """
    gbp_review_name = row.get("gbp_review_name")
    gbp_update_time = row.get("gbp_update_time")
    gbp_reply_update_time = row.get("gbp_reply_update_time")
    gbp_language_code = row.get("gbp_language_code")

    existing = None
    key = None
    if gbp_review_name:
        existing = conn.execute(
            "SELECT * FROM reviews WHERE gbp_review_name = ?", (gbp_review_name,)
        ).fetchone()
        key = gbp_review_name

    if existing is None:
        key = dedup_key(location_name, row)
        existing = conn.execute("SELECT * FROM reviews WHERE dedup_key = ?", (key,)).fetchone()

    if existing is None:
        try:
            conn.execute(
                """INSERT INTO reviews
                   (location_id, canonical_review_id, dedup_key, reviewer_name, review_date,
                    star_rating, review_text, owner_response, review_url, first_seen_at, last_seen_at,
                    gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (location_id, canonical_review_id(row.get("review_url", "")), key,
                 row.get("reviewer_name", ""), row.get("review_date", ""),
                 row.get("star_rating") or None, row.get("review_text", ""),
                 row.get("owner_response", ""), row.get("review_url", ""), now, now,
                 gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code),
            )
        except sqlite3.IntegrityError as e:
            # Both lookups above missed, yet the database's own constraint still
            # caught a real collision -- a genuinely unexpected case (a matching-
            # logic gap, a race, a data-quality issue), not the known migrated-row
            # scenario (which is resolved by the gbp_review_name lookup above, not
            # here). Never silently skip this -- surface enough to actually
            # investigate it.
            raise sqlite3.IntegrityError(
                f"upsert_review: insert collided unexpectedly for location={location_name!r} "
                f"gbp_review_name={gbp_review_name!r} intended dedup_key={key!r}: {e}"
            ) from e
        return "new"

    changed_fields = []
    for field in ("review_text", "owner_response", "star_rating"):
        old_val = existing[field]
        new_val = row.get(field) if field != "star_rating" else (row.get("star_rating") or None)
        old_cmp = old_val if old_val not in ("", None) else None
        new_cmp = new_val if new_val not in ("", None) else None
        if old_cmp != new_cmp and new_cmp is not None:
            changed_fields.append((field, old_val, new_val))

    # Google's own edit timestamp, when available, catches edits the text-diff
    # above could miss and is the accurate signal for API-sourced rows.
    gbp_edit_detected = (
        gbp_update_time is not None
        and existing["gbp_update_time"] is not None
        and gbp_update_time != existing["gbp_update_time"]
    )

    for field, old_val, new_val in changed_fields:
        conn.execute(
            """INSERT INTO review_revisions (review_id, field_changed, old_value, new_value)
               VALUES (?, ?, ?, ?)""",
            (existing["id"], field, str(old_val) if old_val is not None else None,
             str(new_val) if new_val is not None else None),
        )

    # Preserve existing non-empty values when the source returns empty — this
    # prevents a missed CSS selector on re-scrape (or a partial API response)
    # from clearing a response that was already captured and stored.
    new_response = (row.get("owner_response") or "").strip()
    final_response = new_response if new_response else (existing["owner_response"] or "")
    new_text = (row.get("review_text") or "").strip()
    final_text = new_text if new_text else (existing["review_text"] or "")

    conn.execute(
        """UPDATE reviews SET review_text = ?, owner_response = ?, star_rating = ?,
           last_seen_at = ?, missing_since = NULL, is_deleted = 0, deleted_detected_at = NULL,
           gbp_review_name = COALESCE(?, gbp_review_name),
           dedup_key = COALESCE(?, dedup_key),
           gbp_update_time = COALESCE(?, gbp_update_time),
           gbp_reply_update_time = COALESCE(?, gbp_reply_update_time),
           gbp_language_code = COALESCE(?, gbp_language_code)
           WHERE id = ?""",
        (final_text, final_response,
         row.get("star_rating") or existing["star_rating"],
         # dedup_key is normalized to gbp_review_name whenever this row has (or is
         # newly gaining) one -- the same invariant link_review_to_gbp() upholds.
         # COALESCE means a row without a gbp_review_name keeps its existing
         # dedup_key untouched, exactly as before.
         now, gbp_review_name, gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code,
         existing["id"]),
    )
    return "edited" if (changed_fields or gbp_edit_detected) else "unchanged"


def detect_deletions(conn, location_id: int, scraped_keys: set, window_min_date: str, now: str) -> int:
    """
    Mark reviews as deleted if they fall within this run's scraped date window
    (i.e. should have been re-encountered) but weren't seen for two consecutive
    runs in a row (DELETION_GRACE), so a single stalled scrape doesn't cause a
    false-positive deletion. Returns the count newly marked deleted.
    """
    if not window_min_date:
        return 0
    candidates = conn.execute(
        """SELECT id, dedup_key, missing_since FROM reviews
           WHERE location_id = ? AND review_date >= ? AND is_deleted = 0""",
        (location_id, window_min_date),
    ).fetchall()

    newly_deleted = 0
    now_dt = datetime.fromisoformat(now)
    for r in candidates:
        if r["dedup_key"] in scraped_keys:
            continue
        if r["missing_since"] is None:
            conn.execute("UPDATE reviews SET missing_since = ? WHERE id = ?", (now, r["id"]))
            continue
        missing_since_dt = datetime.fromisoformat(r["missing_since"])
        if now_dt - missing_since_dt >= DELETION_GRACE:
            conn.execute(
                "UPDATE reviews SET is_deleted = 1, deleted_detected_at = ? WHERE id = ?",
                (now, r["id"]),
            )
            newly_deleted += 1
    return newly_deleted
