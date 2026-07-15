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
    updating the row that was actually matched."""
    conn.execute(
        """UPDATE reviews SET gbp_review_name = ?, gbp_update_time = ?,
           gbp_reply_update_time = ?, gbp_language_code = ? WHERE id = ?""",
        (gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code, review_id),
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
    When present, gbp_review_name becomes the identity key (see dedup_key()) and
    gbp_update_time becomes an authoritative edit signal straight from Google, on top
    of the existing text/rating/response comparison below.
    """
    key = dedup_key(location_name, row)
    existing = conn.execute("SELECT * FROM reviews WHERE dedup_key = ?", (key,)).fetchone()

    gbp_review_name = row.get("gbp_review_name")
    gbp_update_time = row.get("gbp_update_time")
    gbp_reply_update_time = row.get("gbp_reply_update_time")
    gbp_language_code = row.get("gbp_language_code")

    if existing is None:
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
           gbp_update_time = COALESCE(?, gbp_update_time),
           gbp_reply_update_time = COALESCE(?, gbp_reply_update_time),
           gbp_language_code = COALESCE(?, gbp_language_code)
           WHERE id = ?""",
        (final_text, final_response,
         row.get("star_rating") or existing["star_rating"],
         now, gbp_review_name, gbp_update_time, gbp_reply_update_time, gbp_language_code,
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
