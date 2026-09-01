"""
Administrative population tool for the restaurant bad-review email
workflow's location-to-contact-email mapping (db.py's locations.contact_email
/contact_name/contact_active columns). Never run by any scheduled pipeline
stage -- this is a one-off/occasional manual action, run by hand.

SUPERSEDED (Phase 8, Milestone 8.4/8.5): Restaurant Contacts are now
dashboard-editable and take effect immediately -- Settings -> Restaurant
Contacts (dashboard/api/_lib/contactStore.js, a live Upstash Redis store)
is the authoritative source for every send, not these db.py columns. This
script is retained only as an emergency CLI fallback for if the dashboard
itself is unreachable, and no longer needs to be run for routine contact
changes. See README "Restaurant Contacts Store" for the full migration.

Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED. This script reads
AND writes the real, tenant-owned review database (db.set_location_contact()
below), so it gets the same fail-closed treatment as every other
production-capable entrypoint, even though it's an emergency/occasional
fallback rather than a scheduled pipeline step.

Usage:
    python set_location_contacts.py --tenant-id t_los-tres-amigos --status
        Lists every location and whether it has a configured, active
        contact -- never prints the actual email addresses to stdout in
        bulk (see NOTE below), just configured/missing/inactive per name.
        Safe to run anytime; makes no changes.

    python set_location_contacts.py --tenant-id t_los-tres-amigos --from-csv location_contacts.csv
        Reads a local CSV (NOT committed to git -- see .gitignore) with
        columns: location_name, contact_email, contact_name (optional),
        active (optional, "true"/"false", default true). Matches
        location_name case-insensitively against locations.name. Reports
        exactly which locations were updated and which known locations are
        still unconfigured afterward.

    python set_location_contacts.py --tenant-id t_los-tres-amigos --set "Location Name" contact@example.com [--name "Contact Name"] [--inactive]
        Sets a single location's contact directly from the command line.

This script deliberately contains NO real contact email addresses and
invents none -- every value comes from a file or argument the operator
supplies. It is safe to run this script with an empty/incomplete CSV;
locations left unconfigured simply keep contact_email = NULL, and the send
feature disables sending for them rather than guessing a recipient.
"""
import argparse
import csv
import sys
from pathlib import Path

import db
import tenant_keys
import tenant_paths


def cmd_status(conn):
    rows = conn.execute(
        "SELECT id, name, is_active, contact_email, contact_active FROM locations ORDER BY name"
    ).fetchall()
    configured = [r for r in rows if r["contact_email"] and r["contact_active"]]
    missing = [r for r in rows if not r["contact_email"]]
    inactive = [r for r in rows if r["contact_email"] and not r["contact_active"]]

    print(f"{len(rows)} location(s) total")
    print(f"  {len(configured)} with an active configured contact")
    print(f"  {len(missing)} with NO contact configured:")
    for r in missing:
        print(f"    - {r['name']}" + ("" if r["is_active"] else " (location inactive)"))
    if inactive:
        print(f"  {len(inactive)} with a contact on file but marked inactive:")
        for r in inactive:
            print(f"    - {r['name']}")


def _find_location_id(conn, name: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM locations WHERE lower(name) = lower(?)", (name.strip(),)
    ).fetchone()
    return row["id"] if row else None


def cmd_from_csv(conn, csv_path: str):
    path = Path(csv_path)
    if not path.exists():
        print(f"ERROR: {csv_path} not found")
        sys.exit(1)

    updated, errors = [], []
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("location_name") or "").strip()
            email = (row.get("contact_email") or "").strip()
            contact_name = (row.get("contact_name") or "").strip() or None
            active = (row.get("active") or "true").strip().lower() != "false"
            if not name or not email:
                errors.append(f"skipped row (missing location_name/contact_email): {row}")
                continue
            loc_id = _find_location_id(conn, name)
            if loc_id is None:
                errors.append(f"no matching location for name {name!r}")
                continue
            try:
                db.set_location_contact(conn, loc_id, email, contact_name, active)
                updated.append(name)
            except ValueError as e:
                errors.append(str(e))
    conn.commit()

    print(f"Updated {len(updated)} location(s): {', '.join(updated) if updated else '(none)'}")
    if errors:
        print(f"{len(errors)} row(s) skipped:")
        for e in errors:
            print(f"  - {e}")
    cmd_status(conn)


def cmd_set(conn, name: str, email: str, contact_name: str | None, active: bool):
    loc_id = _find_location_id(conn, name)
    if loc_id is None:
        print(f"ERROR: no location named {name!r}")
        sys.exit(1)
    db.set_location_contact(conn, loc_id, email, contact_name, active)
    conn.commit()
    print(f"Updated contact for {name!r}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", action="store_true", help="show configuration status for every location")
    parser.add_argument("--from-csv", metavar="PATH", help="bulk-load contacts from a local CSV file")
    parser.add_argument("--set", nargs=2, metavar=("LOCATION_NAME", "EMAIL"), help="set one location's contact")
    parser.add_argument("--name", metavar="CONTACT_NAME", help="optional display name, used with --set")
    parser.add_argument("--inactive", action="store_true", help="mark the contact inactive, used with --set")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to update. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::set_location_contacts.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::set_location_contacts.py: {e}")
        sys.exit(1)

    conn = db.get_connection()
    db.init_schema(conn)

    if args.from_csv:
        cmd_from_csv(conn, args.from_csv)
    elif args.set:
        cmd_set(conn, args.set[0], args.set[1], args.name, not args.inactive)
    else:
        cmd_status(conn)

    conn.close()


if __name__ == "__main__":
    main()
