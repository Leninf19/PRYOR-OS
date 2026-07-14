import json
import csv
import os
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

# All Takeout export roots — reviews are deduplicated by review name across all
BASES = [
    Path(__file__).parent / "account-109439479242615524495",
    Path(__file__).parent / "Google Business Profile" / "account-109439479242615524495",
    Path(__file__).parent / "takeout-20260624T223904Z-3-002" / "Takeout" / "Google Business Profile" / "account-109439479242615524495",
]
OUT  = Path(__file__).parent / "reviews.csv"

STAR_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}

# Location name + city looked up from data.json / additionalData.json / profile description
LOCATION_META = {
    "location-11426125089931279310": ("Los Tres Amigos Livonia",        "Livonia"),
    "location-15520570976876227550": ("Los Tres Amigos Chelsea",        "Chelsea"),
    "location-18128411986585884672": ("Los Tres Amigos Owosso",         "Owosso"),
    "location-2415494951923383748":  ("Los Tres Amigos Mason",          "Mason"),
    "location-3008407792806294632":  ("Los Tres Amigos Jackson",        "Jackson"),
    "location-5406312986153974443":  ("Mi Lindo San Blas Detroit",      "Detroit"),
    "location-7614959285102377272":  ("Los Tres Mex Grill East Lansing","East Lansing"),
    "location-7830323824056397313":  ("Los Tres Amigos Lansing",         "Lansing"),
    "location-17869591052461154481": ("Los Tres Amigos Canton",          "Canton"),
    "location-220481549468970310":   ("Los Tres Amigos Farmington",      "Farmington"),
    "location-8820883103287495181":  ("Los Tres Amigos Holt",           "Holt"),
    "location-9283672231565708751":  ("Los Tres Mex Grill Jackson",     "Jackson"),
    "location-9316901949662054295":  ("Los Tres Amigos Howell",         "Howell"),
    "location-9324876672774556262":  ("Los Tres Amigos Plymouth",       "Plymouth"),
}

def parse_review_date(ts: str) -> str:
    """Return YYYY-MM-DD from an ISO-8601 timestamp string."""
    ts = ts.rstrip("Z")
    # Handle both '2026-06-15T16:16:59.158625' and '2017-06-11T23:43:40'
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(ts, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ts[:10]  # fallback

def review_url(name_field: str) -> str:
    """Derive a best-effort Google Maps review URL from the GBP review name."""
    # name format: accounts/<acct>/locations/<loc>/reviews/<reviewId>
    parts = name_field.split("/")
    if len(parts) >= 6:
        review_id = parts[-1]
        return f"https://search.google.com/local/reviews?placeid={review_id}"
    return ""

def load_reviews_from_dir(loc_dir: Path) -> list[dict]:
    reviews = []
    # Collect all review JSON files (reviews.json + reviews-*.json)
    for f in sorted(loc_dir.glob("reviews*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  WARN: could not parse {f.name}: {e}")
            continue
        for r in data.get("reviews", []):
            reviews.append(r)
    return reviews

rows = []
seen_review_names = set()

for loc_id, (loc_name, city) in LOCATION_META.items():
    raw_reviews = []
    for base in BASES:
        loc_dir = base / loc_id
        if loc_dir.exists():
            raw_reviews.extend(load_reviews_from_dir(loc_dir))

    if not raw_reviews:
        print(f"WARN: no review files found for {loc_id}")
        continue

    added = 0
    for r in raw_reviews:
        review_name = r.get("name", "")
        if review_name in seen_review_names:
            continue
        seen_review_names.add(review_name)

        star_str = r.get("starRating", "")
        star_int = STAR_MAP.get(star_str)
        if star_int is None:
            print(f"  WARN: unknown starRating '{star_str}' in {review_name}")
            star_int = ""

        create_time = r.get("createTime", "")
        review_date = parse_review_date(create_time) if create_time else ""

        comment = r.get("comment", "")
        reviewer = r.get("reviewer", {}).get("displayName", "")
        reply_obj = r.get("reviewReply", {})
        owner_response = reply_obj.get("comment", "") if reply_obj else ""
        url = review_url(review_name)

        rows.append({
            "location_name":   loc_name,
            "city":            city,
            "reviewer_name":   reviewer,
            "review_date":     review_date,
            "star_rating":     star_int,
            "review_text":     comment,
            "owner_response":  owner_response,
            "review_url":      url,
        })
        added += 1

    print(f"{loc_name}: {added} reviews loaded")

# Write CSV
FIELDNAMES = ["location_name","city","reviewer_name","review_date","star_rating","review_text","owner_response","review_url"]
with OUT.open("w", newline="", encoding="utf-8") as fh:
    writer = csv.DictWriter(fh, fieldnames=FIELDNAMES, quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(rows)

# Summary stats
total = len(rows)
print(f"\n=== SUMMARY ===")
print(f"Total reviews: {total}")
print(f"Output file:   {OUT}")

counts = defaultdict(int)
dates = []
for r in rows:
    counts[r["location_name"]] += 1
    if r["review_date"]:
        dates.append(r["review_date"])

print("\nPer-location counts:")
for name, count in sorted(counts.items(), key=lambda x: -x[1]):
    print(f"  {name}: {count}")

if dates:
    dates.sort()
    print(f"\nEarliest review: {dates[0]}")
    print(f"Latest review:   {dates[-1]}")
