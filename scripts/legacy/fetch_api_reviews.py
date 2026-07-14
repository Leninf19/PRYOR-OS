import csv
import time
from pathlib import Path
from datetime import datetime

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
import requests as req

BASE_DIR    = Path(__file__).parent
CREDS_FILE  = BASE_DIR / "credentials.json"
TOKEN_FILE  = BASE_DIR / "token.json"
OUT_CSV     = BASE_DIR / "reviews.csv"
ACCOUNT_ID  = "109439479242615524495"
SCOPES      = ["https://www.googleapis.com/auth/business.manage"]
FIELDNAMES  = ["location_name","city","reviewer_name","review_date",
               "star_rating","review_text","owner_response","review_url"]
STAR_MAP    = {"ONE":1,"TWO":2,"THREE":3,"FOUR":4,"FIVE":5}

# The 9 location IDs from Takeout that had no review files — we probe each one
# via the v4 API to find which ones match our 8 targets.
UNKNOWN_LOC_IDS = [
    "13469418931528651506",
    "15351769851328883763",
    "15609737357303747786",
    "17869591052461154481",   # known: Los Tres Amigos Canton
    "220481549468970310",
    "2234164278605362201",
    "538062920722801625",
    "6494340890109321866",
    "7052843393365981233",
]

# Target CSV name + city keyed by keywords we expect in the GBP title
TARGETS = [
    ("Los Tres Amigos Canton",         "Canton",          ["canton"]),
    ("Los Tres Amigos Farmington",      "Farmington",      ["farmington"]),
    ("Los Tres Amigos Northville",      "Northville",      ["northville"]),
    ("Los Tres Amigos Lansing",         "Lansing",         ["lansing", "saginaw hwy"]),
    ("Los Tres Amigos Michigan Center", "Michigan Center", ["michigan center"]),
    ("Los Tres Amigos West Jackson",    "Jackson",         ["west jackson", "w michigan"]),
    ("Mi Lindo San Blas Lincoln Park",  "Lincoln Park",    ["lincoln park", "fort st"]),
    ("Rio Luna Tacos & Tequila",        "Saginaw",         ["rio luna", "bay rd"]),
]

# ── helpers ───────────────────────────────────────────────────────────────────

def get_creds():
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json())
    return creds

def api_get(creds, url, params=None, silent=False):
    r = req.get(url, headers={"Authorization": f"Bearer {creds.token}"}, params=params)
    if not r.ok:
        if not silent:
            print(f"  API {r.status_code}: {r.text[:200]}")
        return None
    return r.json()

def get_location_info(creds, loc_id):
    """Fetch location title + address via v4 API."""
    url  = f"https://mybusiness.googleapis.com/v4/accounts/{ACCOUNT_ID}/locations/{loc_id}"
    data = api_get(creds, url, silent=True)
    if not data:
        return None
    addr  = data.get("address", {})
    lines = addr.get("addressLines", [])
    city  = addr.get("locality", "")
    return {
        "title":    data.get("locationName", ""),
        "city":     city,
        "address":  " ".join(lines).lower(),
    }

def get_reviews(creds, loc_id):
    url    = f"https://mybusiness.googleapis.com/v4/accounts/{ACCOUNT_ID}/locations/{loc_id}/reviews"
    params = {"pageSize": 50}
    revs   = []
    while True:
        data = api_get(creds, url, params)
        if not data:
            break
        revs.extend(data.get("reviews", []))
        tok = data.get("nextPageToken")
        if not tok:
            break
        params["pageToken"] = tok
        time.sleep(0.5)
    return revs

def match_target(title, city, address):
    t = title.lower()
    c = city.lower()
    a = address.lower()
    for csv_name, csv_city, keywords in TARGETS:
        for kw in keywords:
            if kw in t or kw in c or kw in a:
                return (csv_name, csv_city)
    return None

def parse_date(ts):
    ts = ts.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(ts, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ts[:10]

def make_url(review_name):
    parts = review_name.split("/")
    return f"https://search.google.com/local/reviews?placeid={parts[-1]}" if len(parts) >= 6 else ""

# ── load existing CSV ─────────────────────────────────────────────────────────

existing_rows = []
seen_urls     = set()
if OUT_CSV.exists():
    with OUT_CSV.open("r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            existing_rows.append(row)
            seen_urls.add(row.get("review_url", ""))
print(f"Existing CSV: {len(existing_rows)} rows (loaded for dedup).")

# ── auth ──────────────────────────────────────────────────────────────────────

print("\nAuthenticating...")
creds = get_creds()
print("Authenticated.")

# ── probe each unknown location ID ───────────────────────────────────────────

print(f"\nProbing {len(UNKNOWN_LOC_IDS)} location IDs via v4 API...")
matched = {}   # csv_name -> loc_id

for loc_id in UNKNOWN_LOC_IDS:
    info = get_location_info(creds, loc_id)
    if not info:
        print(f"  {loc_id}: not accessible")
        time.sleep(0.3)
        continue

    title   = info["title"]
    city    = info["city"]
    address = info["address"]
    m = match_target(title, city, address)
    if m:
        csv_name, csv_city = m
        matched[csv_name] = loc_id
        print(f"  ✓ {loc_id} → '{title}' ({city}) matched as [{csv_name}]")
    else:
        print(f"  ? {loc_id} → '{title}' ({city}) — no target match")
    time.sleep(0.3)

unmatched_targets = [t[0] for t in TARGETS if t[0] not in matched]
if unmatched_targets:
    print(f"\n  ✗ Could not match: {unmatched_targets}")

# ── fetch reviews for each matched location ───────────────────────────────────

new_rows = []
for csv_name, loc_id in matched.items():
    csv_city = next(t[1] for t in TARGETS if t[0] == csv_name)
    print(f"\nFetching reviews: {csv_name} (id={loc_id}) ...")
    revs  = get_reviews(creds, loc_id)
    added = 0
    for r in revs:
        url = make_url(r.get("name", ""))
        if url in seen_urls:
            continue
        seen_urls.add(url)
        reply = r.get("reviewReply") or {}
        new_rows.append({
            "location_name":  csv_name,
            "city":           csv_city,
            "reviewer_name":  r.get("reviewer", {}).get("displayName", ""),
            "review_date":    parse_date(r["createTime"]) if r.get("createTime") else "",
            "star_rating":    STAR_MAP.get(r.get("starRating", ""), ""),
            "review_text":    r.get("comment", ""),
            "owner_response": reply.get("comment", ""),
            "review_url":     url,
        })
        added += 1
    print(f"  → {added} new reviews added")

# ── write CSV ─────────────────────────────────────────────────────────────────

all_rows = existing_rows + new_rows
with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=FIELDNAMES, quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(all_rows)

print(f"\n=== DONE ===")
print(f"New reviews added : {len(new_rows)}")
print(f"Total in CSV      : {len(all_rows)}")
print(f"File              : {OUT_CSV}")
