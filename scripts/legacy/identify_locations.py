"""
List all locations in the GBP account to find the missing ones.
Re-authenticates via browser if token is expired.
"""
import json
import requests
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

TOKEN_FILE = Path(__file__).parent / "token.json"
CREDS_FILE = Path(__file__).parent / "credentials.json"
ACCOUNT_ID = "accounts/109439479242615524495"
SCOPES = ["https://www.googleapis.com/auth/business.manage"]

def get_creds():
    creds = None
    if TOKEN_FILE.exists():
        data = json.loads(TOKEN_FILE.read_text())
        creds = Credentials(
            token=data.get("token"),
            refresh_token=data.get("refresh_token"),
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=data.get("client_id"),
            client_secret=data.get("client_secret"),
            scopes=data.get("scopes", SCOPES),
        )
    if not creds or not creds.refresh_token:
        flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
        creds = flow.run_local_server(port=0)
    elif not creds.valid:
        try:
            creds.refresh(Request())
        except Exception:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
    # Save updated token
    TOKEN_FILE.write_text(json.dumps({
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes) if creds.scopes else SCOPES,
    }))
    return creds

creds = get_creds()
headers = {"Authorization": f"Bearer {creds.token}"}

KNOWN = {
    "Los Tres Amigos Livonia", "Los Tres Amigos Chelsea", "Los Tres Amigos Owosso",
    "Los Tres Amigos Mason", "Los Tres Amigos Jackson", "Mi Lindo San Blas Detroit",
    "Los Tres Mex Grill East Lansing", "Hacienda Los Tres Amigos", "Los Tres Amigos Holt",
    "Los Tres Mex Grill Jackson", "Los Tres Amigos Howell", "Los Tres Amigos Plymouth",
}

url = f"https://mybusinessbusinessinformation.googleapis.com/v1/{ACCOUNT_ID}/locations"
params = {"readMask": "name,title,storefrontAddress", "pageSize": 100}

resp = requests.get(url, headers=headers, params=params)
print(f"\nAPI Status: {resp.status_code}")

if resp.status_code == 200:
    locations = resp.json().get("locations", [])
    print(f"Total: {len(locations)} locations\n")
    for loc in locations:
        title = loc.get("title", "?")
        api_name = loc.get("name", "")
        city = loc.get("storefrontAddress", {}).get("locality", "")
        marker = "  ← MISSING FROM CSV" if title not in KNOWN else ""
        print(f"{title:45s} {city:20s} {api_name}{marker}")
else:
    print(resp.text[:600])
