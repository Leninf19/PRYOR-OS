"""
Regression tests for db.py's set_location_contact() and
set_location_contacts.py (restaurant bad-review email workflow, Phase 1 --
location contact-email schema/configuration). Every test runs against a
scratch SQLite file inside tempfile.mkdtemp() -- the real
dashboard/reviews.db is never opened by this file.

Run directly: py tests/test_location_contacts.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import set_location_contacts as slc

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="location_contacts_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return conn


def _insert_location(conn, name="Casa Tequila Testtown"):
    conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return conn.execute("SELECT id FROM locations WHERE name = ?", (name,)).fetchone()["id"]


def test_migration_adds_columns_with_safe_defaults():
    conn = _fresh_db()
    loc_id = _insert_location(conn)
    row = conn.execute("SELECT contact_email, contact_name, contact_active FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_email"] is None, "a pre-existing/new location must start with NO contact configured"
    assert row["contact_name"] is None
    assert row["contact_active"] == 1, "contact_active must default to true (NOT NULL DEFAULT 1)"


def test_set_location_contact_happy_path():
    conn = _fresh_db()
    loc_id = _insert_location(conn)
    db.set_location_contact(conn, loc_id, "manager@example.com", "Jane Manager", active=True)
    conn.commit()
    row = conn.execute("SELECT contact_email, contact_name, contact_active FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_email"] == "manager@example.com"
    assert row["contact_name"] == "Jane Manager"
    assert row["contact_active"] == 1


def test_set_location_contact_rejects_invalid_email():
    conn = _fresh_db()
    loc_id = _insert_location(conn)
    threw = False
    try:
        db.set_location_contact(conn, loc_id, "not-an-email", None)
    except ValueError:
        threw = True
    assert threw, "an invalid email shape must raise ValueError, never be silently stored"
    row = conn.execute("SELECT contact_email FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_email"] is None, "a rejected email must never be partially written"


def test_set_location_contact_rejects_unknown_location():
    conn = _fresh_db()
    threw = False
    try:
        db.set_location_contact(conn, 999999, "manager@example.com", None)
    except ValueError:
        threw = True
    assert threw, "an unknown location_id must raise ValueError, not silently no-op"


def test_set_location_contact_can_mark_inactive():
    conn = _fresh_db()
    loc_id = _insert_location(conn)
    db.set_location_contact(conn, loc_id, "manager@example.com", None, active=False)
    conn.commit()
    row = conn.execute("SELECT contact_active FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_active"] == 0


def test_set_location_contact_email_is_trimmed():
    conn = _fresh_db()
    loc_id = _insert_location(conn)
    db.set_location_contact(conn, loc_id, "  manager@example.com  ", "  Jane  ")
    conn.commit()
    row = conn.execute("SELECT contact_email, contact_name FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_email"] == "manager@example.com"
    assert row["contact_name"] == "Jane"


def test_status_reports_missing_and_configured_separately():
    conn = _fresh_db()
    configured_id = _insert_location(conn, "Configured Location")
    _insert_location(conn, "Unconfigured Location")
    db.set_location_contact(conn, configured_id, "manager@example.com", None)
    conn.commit()

    rows = conn.execute("SELECT name, contact_email, contact_active FROM locations ORDER BY name").fetchall()
    configured = [r for r in rows if r["contact_email"] and r["contact_active"]]
    missing = [r for r in rows if not r["contact_email"]]
    assert len(configured) == 1 and configured[0]["name"] == "Configured Location"
    assert len(missing) == 1 and missing[0]["name"] == "Unconfigured Location"


def test_from_csv_case_insensitive_name_match_and_error_reporting():
    conn = _fresh_db()
    loc_id = _insert_location(conn, "Casa Tequila Testtown")
    tmpdir = tempfile.mkdtemp(prefix="location_contacts_csv_")
    csv_path = Path(tmpdir) / "contacts.csv"
    csv_path.write_text(
        "location_name,contact_email,contact_name,active\n"
        "casa tequila testtown,manager@example.com,Jane,true\n"
        "Nonexistent Location,ghost@example.com,,true\n"
        ",missing-name@example.com,,true\n",
        encoding="utf-8",
    )
    slc.cmd_from_csv(conn, str(csv_path))
    row = conn.execute("SELECT contact_email FROM locations WHERE id = ?", (loc_id,)).fetchone()
    assert row["contact_email"] == "manager@example.com", "location_name match must be case-insensitive"


def test_from_csv_missing_file_exits_cleanly():
    conn = _fresh_db()
    exited = False
    try:
        slc.cmd_from_csv(conn, "/nonexistent/path/contacts.csv")
    except SystemExit:
        exited = True
    assert exited, "a missing CSV path must exit cleanly, not raise an unhandled exception"


def main():
    tests = [
        ("migration adds contact_email/contact_name/contact_active with safe defaults", test_migration_adds_columns_with_safe_defaults),
        ("set_location_contact happy path", test_set_location_contact_happy_path),
        ("set_location_contact rejects an invalid email shape", test_set_location_contact_rejects_invalid_email),
        ("set_location_contact rejects an unknown location_id", test_set_location_contact_rejects_unknown_location),
        ("set_location_contact can mark a contact inactive", test_set_location_contact_can_mark_inactive),
        ("set_location_contact trims email/name whitespace", test_set_location_contact_email_is_trimmed),
        ("status reports missing vs configured contacts separately", test_status_reports_missing_and_configured_separately),
        ("--from-csv matches location_name case-insensitively and reports errors", test_from_csv_case_insensitive_name_match_and_error_reporting),
        ("--from-csv with a missing file exits cleanly", test_from_csv_missing_file_exits_cleanly),
    ]
    for name, fn in tests:
        run(name, fn)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{len([r for r in results if not r])} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
