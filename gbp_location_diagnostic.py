"""
gbp_location_diagnostic.py -- ONE-TIME, read-only diagnostic for Recovery
Milestone 3 Phase 4: GBP Test Connection discovers 23 Google Business
Profile locations, but exactly 22 are linked in dashboard/reviews.db's
`locations` table. This script proves which two GBP locations collide
under provider_sync.py's _link_locations() matching rules, without
performing a real sync and without writing anything anywhere.

Read-only guarantees:
  - Google side: calls only GBPProvider().discover_locations() (list
    accounts, list locations) -- the exact same architecture
    sync_reviews.py uses, but this script never calls fetch_reviews() or
    reply_to_review(), and never runs provider_sync.sync_all().
  - Local DB side: opens dashboard/reviews.db via a SQLite read-only URI
    connection (mode=ro) -- not db.py's connect(), which runs schema
    migrations (CREATE TABLE/ALTER TABLE) as a side effect of opening.
    Any accidental write attempt against a mode=ro connection raises
    immediately rather than silently succeeding.
  - _link_locations() itself (provider_sync.py) is never called -- it
    performs real writes (db.set_location_gbp_info(),
    db.get_or_create_location()). Its matching logic is reimplemented
    here verbatim, read-only, for simulation only.

Usage: py gbp_location_diagnostic.py --tenant-id t_los-tres-amigos
"""
import argparse
import re
import sqlite3
import sys
from pathlib import Path

import tenant_keys
import tenant_paths
from provider_gbp import GBPProvider

# Multi-Tenant Phase 4D: resolved in main() from --tenant-id via
# tenant_paths.resolve_review_db_path() -- never a hardcoded default.
# Module-global (like export_chunks.py's PRIVATE_DATA_DIR) because this is
# a short-lived, single-tenant-per-invocation script, not a server.
DB_PATH: Path | None = None


# Verbatim copy of provider_sync.py's _norm_name -- must match exactly,
# since the whole point is simulating its matching decisions.
def _norm_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def load_local_locations():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT id, name, city, gbp_location_name FROM locations WHERE is_active = 1"
    ).fetchall()]
    conn.close()
    return rows


def gbp_review_name_counts(local_id: int, candidate_external_ids: list[str]):
    """For a colliding local_id, counts how many of its ACTIVE reviews'
    gbp_review_name currently carry each candidate external_id's location
    segment -- direct, quantified proof of whether reviews from both GBP
    listings ended up stored under this one local row. Read-only SELECT
    only; never touches reviews.gbp_review_name in any write sense."""
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    counts = {}
    for ext_id in candidate_external_ids:
        prefix = ext_id + "/"
        n = conn.execute(
            "SELECT COUNT(*) FROM reviews WHERE location_id = ? AND is_deleted = 0 "
            "AND gbp_review_name LIKE ?",
            (local_id, prefix + "%"),
        ).fetchone()[0]
        counts[ext_id] = n
    total_gbp_linked = conn.execute(
        "SELECT COUNT(*) FROM reviews WHERE location_id = ? AND is_deleted = 0 "
        "AND gbp_review_name IS NOT NULL",
        (local_id,),
    ).fetchone()[0]
    conn.close()
    return counts, total_gbp_linked


def format_address(address: dict) -> str:
    if not address:
        return ""
    lines = address.get("addressLines") or []
    parts = [", ".join(lines)] if lines else []
    for key in ("locality", "administrativeArea", "postalCode"):
        val = address.get(key)
        if val:
            parts.append(str(val))
    return ", ".join(p for p in parts if p)


def main():
    global DB_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose Google credential to use. REQUIRED -- no default. "
                              "This script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::gbp_location_diagnostic.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::gbp_location_diagnostic.py: {e}")
        sys.exit(1)

    print("=== gbp_location_diagnostic.py -- READ-ONLY, one-time run ===\n")

    our_locations = load_local_locations()
    print(f"Local `locations` table: {len(our_locations)} active rows.\n")

    provider = GBPProvider(tenant_id=args.tenant_id)
    provider_locations = provider.discover_locations()
    print(f"GBP discover_locations(): {len(provider_locations)} locations discovered.\n")

    by_name = {_norm_name(l["name"]): l for l in our_locations}

    # Simulates _link_locations()'s exact resolution logic, read-only.
    rows = []
    resolution_by_local_id = {}  # local_id -> [ {external_id, gbp_name, match_type}, ... ]

    for ploc in provider_locations:
        gname = _norm_name(ploc.name)
        address_str = format_address(ploc.address)

        exact_match = next((l for l in our_locations if l["gbp_location_name"] == ploc.external_id), None)
        fuzzy_exact_name = by_name.get(gname)
        fuzzy_substring = next(
            (l for l in our_locations
             if gname and (gname in _norm_name(l["name"]) or _norm_name(l["name"]) in gname)),
            None,
        ) if not fuzzy_exact_name else None

        if exact_match:
            match_type = "exact gbp_location_name"
            resolved = exact_match
        elif fuzzy_exact_name:
            match_type = "fuzzy: exact normalized name"
            resolved = fuzzy_exact_name
        elif fuzzy_substring:
            match_type = "fuzzy: substring containment"
            resolved = fuzzy_substring
        else:
            match_type = "NO MATCH -- would create new location"
            resolved = None

        row = {
            "gbp_name": ploc.name,
            "gbp_id": ploc.external_id,
            "address": address_str,
            "city": ploc.city,
            "normalized_name": gname,
            "exact_local_match": exact_match["name"] if exact_match else None,
            "fuzzy_local_match": (fuzzy_exact_name or fuzzy_substring)["name"] if (fuzzy_exact_name or fuzzy_substring) else None,
            "existing_local_gbp_location_name": resolved["gbp_location_name"] if resolved else None,
            "resolved_local_id": resolved["id"] if resolved else None,
            "resolved_local_name": resolved["name"] if resolved else None,
            "match_type": match_type,
        }
        rows.append(row)

        if resolved:
            resolution_by_local_id.setdefault(resolved["id"], []).append(
                {"external_id": ploc.external_id, "gbp_name": ploc.name, "match_type": match_type}
            )

    # --- 23-row reconciliation table ---
    print("=" * 140)
    print(f"{'GBP Name':32} | {'GBP ID (last 24 chars)':26} | {'City/Address':28} | {'Local Match':26} | {'Match Type':32} | Collision")
    print("=" * 140)
    collision_local_ids = {lid for lid, matches in resolution_by_local_id.items() if len(matches) > 1}
    for r in rows:
        collision_flag = "*** COLLISION ***" if r["resolved_local_id"] in collision_local_ids else ""
        local_match_display = r["exact_local_match"] or r["fuzzy_local_match"] or "(none -- new)"
        print(f"{r['gbp_name'][:32]:32} | {r['gbp_id'][-26:]:26} | {(r['address'] or r['city'] or '')[:28]:28} | {local_match_display[:26]:26} | {r['match_type'][:32]:32} | {collision_flag}")
    print("=" * 140)
    print()

    # --- Collision analysis ---
    if not collision_local_ids:
        print("No collision detected -- 23 GBP locations resolved to 23 distinct local rows or new-location creations.")
        print("(This would be unexpected given the dashboard reports 22/22 linked with 23 discovered; re-verify inputs.)")
    for lid in collision_local_ids:
        matches = resolution_by_local_id[lid]
        local_row = next(l for l in our_locations if l["id"] == lid)
        print(f"--- COLLISION on local location id={lid} ('{local_row['name']}') ---")
        print(f"  {len(matches)} GBP locations resolve here:")
        for m in matches:
            print(f"    - {m['gbp_name']!r}  external_id={m['external_id']}  via {m['match_type']}")
        currently_stored = local_row["gbp_location_name"]
        print(f"  Currently stored locally (locations.gbp_location_name): {currently_stored}")
        for m in matches:
            status = "CURRENTLY STORED" if m["external_id"] == currently_stored else "LOST / OVERWRITTEN (not the current pointer)"
            print(f"    - {m['external_id']}: {status}")

        candidate_ids = [m["external_id"] for m in matches]
        counts, total_linked = gbp_review_name_counts(lid, candidate_ids)
        print(f"  Active GBP-linked reviews currently stored under local id={lid}: {total_linked} total")
        for ext_id, n in counts.items():
            print(f"    - reviews whose gbp_review_name belongs to {ext_id}: {n}")
        both_present = sum(1 for n in counts.values() if n > 0) > 1
        print(f"  Reviews from BOTH GBP listings present under this one local location: {'YES' if both_present else 'no'}")
        print()

    print("=== END gbp_location_diagnostic.py ===")


if __name__ == "__main__":
    main()
