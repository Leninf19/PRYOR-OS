"""
Headless scraper for all 21 LTA restaurants.
Run by GitHub Actions every 6 hours.
Writes new reviews to dashboard/reviews.db (source of truth) and
dashboard/reviews.csv (secondary export), and outputs GitHub Actions variables.
"""
import os
import sys
import csv
import re
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import defaultdict

import db
import digest_filters

BASE_DIR      = Path(__file__).parent
REVIEWS_CSV   = BASE_DIR / "dashboard" / "reviews.csv"
LOGS_DIR      = BASE_DIR / "logs"
GITHUB_OUTPUT = os.environ.get("GITHUB_OUTPUT", "")

# --local: headed browser, full 3000-review scroll, git push + Vercel deploy
# --debug: save screenshots + HTML snapshots on failure (auto-enabled in cloud CI)
LOCAL_MODE = "--local" in sys.argv
DEBUG_MODE = "--debug" in sys.argv or bool(GITHUB_OUTPUT)  # always on in CI
MAX_SCROLL    = 3000 if LOCAL_MODE else 300
EXTRACT_EVERY = 50

# "Reviews" button label in every language Google Maps might show
REVIEW_TAB_LABELS = {
    "reviews", "reseñas", "avis", "recensioni", "bewertungen",
    "avaliações", "отзывы", "評論", "리뷰", "レビュー", "ulasan",
    "rezensionen", "valoraciones", "değerlendirmeler",
}

LOCATIONS = [
    {"name": "Los Tres Amigos Livonia",         "city": "Livonia",         "search": "Los Tres Amigos 29441 Five Mile Rd Livonia MI"},
    {"name": "Los Tres Amigos Chelsea",          "city": "Chelsea",         "search": "Los Tres Amigos 350 N Main St Chelsea MI"},
    {"name": "Los Tres Amigos Owosso",           "city": "Owosso",          "search": "Los Tres Amigos 1631 East Main St Owosso MI"},
    {"name": "Los Tres Amigos Mason",            "city": "Mason",           "search": "Los Tres Amigos 447 S Jefferson St Mason MI"},
    {"name": "Los Tres Amigos Jackson",          "city": "Jackson",         "search": "Los Tres Amigos 1111 North West Avenue Jackson MI"},
    {"name": "Mi Lindo San Blas Detroit",        "city": "Detroit",         "search": "Mi Lindo San Blas 1807 Livernois Avenue Detroit MI"},
    {"name": "Los Tres Mex Grill East Lansing",  "city": "East Lansing",    "search": "Los Tres Mex Grill 115 Albert St East Lansing MI"},
    {"name": "Los Tres Amigos Lansing",          "city": "Lansing",         "search": "Los Tres Amigos Lansing MI"},
    {"name": "Los Tres Amigos Canton",           "city": "Canton",          "search": "Los Tres Amigos 6600 N Canton Center Rd Canton MI"},
    {"name": "Los Tres Amigos Farmington",       "city": "Farmington",      "search": "Los Tres Amigos Farmington MI"},
    {"name": "Los Tres Amigos Holt",             "city": "Holt",            "search": "Los Tres Amigos 2457 Cedar St Holt MI"},
    {"name": "Los Tres Mex Grill Jackson",       "city": "Jackson",         "search": "Los Tres Mex Grill 3236 Michigan Ave Jackson MI"},
    {"name": "Los Tres Amigos Howell",           "city": "Howell",          "search": "Los Tres Amigos Howell MI"},
    {"name": "Los Tres Amigos Plymouth",         "city": "Plymouth",        "search": "Los Tres Amigos 39500 Ann Arbor Road Plymouth MI"},
    {"name": "Rio Luna Tacos & Tequila",         "city": "Saginaw",         "search": "Rio Luna Tacos Tequila Saginaw MI"},
    {"name": "Mi Lindo San Blas Lincoln Park",   "city": "Lincoln Park",    "search": "Mi Lindo San Blas 3456 Fort Street Lincoln Park MI"},
    {"name": "Los Tres Amigos West Jackson",     "city": "Jackson",         "search": "Los Tres Amigos 1923 West Michigan Avenue Jackson MI"},
    {"name": "Los Tres Amigos Northville",       "city": "Northville",      "search": "Los Tres Amigos 144 Mary Alexander Ct Northville MI"},
    {"name": "Los Tres Amigos Michigan Center",  "city": "Michigan Center", "search": "Los Tres Amigos 328 5th St Michigan Center MI"},
    {"name": "Casa Tequila Brighton",            "city": "Brighton",        "search": "Casa Tequila 501 W Main St Brighton MI"},
    {"name": "Casa Tequila Chicago",             "city": "Chicago",         "search": "Casa Tequila 1949 W Division St Chicago IL"},
]

FIELDNAMES = ["location_name", "city", "reviewer_name", "review_date",
              "star_rating", "review_text", "owner_response", "review_url"]

_PLACEID_RE = re.compile(r'placeid=([^&]+)')
_MAPS_ID_RE = re.compile(r'/reviews/([^/?]+)')


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


def dedup_key(row: dict):
    rid = canonical_review_id(row.get("review_url", ""))
    if rid:
        return rid
    return (row["location_name"], row["reviewer_name"], row["review_date"], row["star_rating"])


def relative_to_date(text: str) -> str:
    now = datetime.now()
    t = text.lower().strip()
    if not t or "just now" in t or "moment" in t:
        return now.strftime("%Y-%m-%d")
    m = re.search(r'(\d+)\s*(second|minute|hour)', t)
    if m:
        return now.strftime("%Y-%m-%d")
    m = re.search(r'(\d+)\s*day', t)
    if m:
        return (now - timedelta(days=int(m.group(1)))).strftime("%Y-%m-%d")
    m = re.search(r'a\s*week|1\s*week', t)
    if m:
        return (now - timedelta(weeks=1)).strftime("%Y-%m-%d")
    m = re.search(r'(\d+)\s*week', t)
    if m:
        return (now - timedelta(weeks=int(m.group(1)))).strftime("%Y-%m-%d")
    m = re.search(r'a\s*month|1\s*month', t)
    if m:
        return (now - timedelta(days=30)).strftime("%Y-%m-%d")
    m = re.search(r'(\d+)\s*month', t)
    if m:
        return (now - timedelta(days=int(m.group(1)) * 30)).strftime("%Y-%m-%d")
    m = re.search(r'a\s*year|1\s*year', t)
    if m:
        return (now - timedelta(days=365)).strftime("%Y-%m-%d")
    m = re.search(r'(\d+)\s*year', t)
    if m:
        return (now - timedelta(days=int(m.group(1)) * 365)).strftime("%Y-%m-%d")
    return now.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Diagnostic helpers
# ---------------------------------------------------------------------------

async def save_debug_snapshot(page, name: str, step: str) -> str | None:
    """Save a screenshot + HTML dump to logs/ for post-mortem. Returns screenshot path or None."""
    if not DEBUG_MODE:
        return None
    try:
        LOGS_DIR.mkdir(exist_ok=True)
        safe = re.sub(r"[^a-z0-9]+", "-", name.lower())[:35]
        ts   = datetime.now().strftime("%H%M%S")
        shot = LOGS_DIR / f"{safe}-{step}-{ts}.png"
        html = LOGS_DIR / f"{safe}-{step}-{ts}.html"
        await page.screenshot(path=str(shot), full_page=False)
        html.write_text((await page.content())[:400_000], encoding="utf-8")
        print(f"      [DEBUG] screenshot → logs/{shot.name}")
        print(f"      [DEBUG] html dump  → logs/{html.name}")
        return str(shot)
    except Exception as e:
        print(f"      [DEBUG] snapshot failed: {e}")
        return None


async def detect_page_state(page) -> tuple[str, str]:
    """
    Classify the current page. Returns (state, human_detail).

    States:
      'place'   – Google Maps place panel (correct landing)
      'search'  – Maps search results list (need to click a result)
      'consent' – Google consent / cookie gate
      'signin'  – Google sign-in page
      'sorry'   – Google rate-limit / "unusual traffic" block
      'captcha' – CAPTCHA / robot check
      'unknown' – couldn't determine
    """
    url   = page.url or ""
    title = ""
    try:
        title = await page.title()
    except Exception:
        pass

    # URL is the most reliable signal
    if "/maps/place/"   in url:
        return "place",   f"Maps place panel — {url[:80]}"
    if "/maps/search/"  in url:
        return "search",  f"Maps search results — {url[:80]}"
    if "consent.google" in url:
        return "consent", f"Google consent gate — {url[:80]}"
    if "accounts.google" in url:
        return "signin",  f"Google sign-in — {url[:80]}"
    if "/sorry/"        in url or "google.com/sorry" in url:
        return "sorry",   f"Google rate-limit page — {url[:80]}"

    # Content-based fallback
    try:
        body = (await page.content()).lower()
        if "captcha" in body or "recaptcha" in body:
            return "captcha", f"CAPTCHA detected — {url[:80]}"
        if "unusual traffic" in body or "automated requests" in body:
            return "sorry",   f"Automation blocked — {url[:80]}"
        if "/maps/place/" in body and "data-review-id" in body:
            return "place",   f"Place content found in body — {url[:80]}"
    except Exception:
        pass

    return "unknown", f"URL: {url[:80]} | Title: {title[:60]}"


async def try_dismiss_blocking(page) -> bool:
    """Dismiss consent dialogs, cookie banners, and in-Maps popups.
    Returns True if a consent page was explicitly dismissed."""
    url = page.url or ""
    dismissed_consent = False

    if "consent.google" in url:
        for sel in [
            'button[aria-label*="Accept"]',
            'button[aria-label*="Reject"]',
            '#introAgreeButton',
            'button:has-text("Accept all")',
            'button:has-text("Reject all")',
            'button:has-text("I agree")',
        ]:
            try:
                btn = page.locator(sel).first
                if await btn.is_visible(timeout=2000):
                    await btn.click()
                    await page.wait_for_timeout(2500)
                    dismissed_consent = True
                    break
            except Exception:
                pass

    # In-page overlay dialogs (cookie banner, "before you continue", etc.)
    for sel in [
        'button[aria-label="Accept all"]',
        'button[aria-label="Reject all"]',
        'button[jsname="higCR"]',
        'button:has-text("Accept all")',
        'button:has-text("Reject all")',
        'form[action*="consent"] button',
    ]:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=800):
                await btn.click()
                await page.wait_for_timeout(600)
        except Exception:
            pass

    return dismissed_consent


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------

async def _get_stored_maps_url(name: str) -> str:
    """Return the maps_url stored from a previous successful run (may be empty)."""
    try:
        conn = db.get_connection()
        row  = conn.execute(
            "SELECT maps_url FROM locations WHERE name = ? AND maps_url IS NOT NULL AND maps_url != ''",
            (name,),
        ).fetchone()
        conn.close()
        return row["maps_url"] if row else ""
    except Exception:
        return ""


async def navigate_to_place(page, loc: dict) -> tuple[bool, str]:
    """
    Land on the Google Maps place panel for a location.
    Returns (success, failure_reason).

    Strategies tried in order:
      A  Navigate to Maps search URL → check if it auto-redirected to /maps/place/
      B  Follow the first a[href*="/maps/place/"] link found on the search page
      C  Click first visible result card by CSS selector, verify URL changed
      D  Use the maps_url stored in the database from a prior successful run
    """
    name   = loc["name"]
    search = loc["search"]
    search_url = "https://www.google.com/maps/search/" + search.replace(" ", "+")

    # ── A. Navigate to search URL ──────────────────────────────────────────
    print(f"    [nav] Navigating: {search_url}")
    try:
        await page.goto(search_url, wait_until="domcontentloaded", timeout=35000)
    except Exception as e:
        return False, f"Navigation timeout/error: {e}"

    await page.wait_for_timeout(3500)

    # Check for blocking pages first
    state, detail = await detect_page_state(page)
    print(f"    [nav] Page state after load: {state} — {detail}")

    if state in ("consent", "signin"):
        print(f"    [nav] Dismissing {state} page...")
        await try_dismiss_blocking(page)
        await page.wait_for_timeout(2500)
        state, detail = await detect_page_state(page)
        print(f"    [nav] After dismiss: {state}")
        if state in ("consent", "signin"):
            return False, f"Blocked by {state} page — dismissal failed"

    if state == "sorry":
        return False, "Google rate-limit / automation block detected"
    if state == "captcha":
        return False, "CAPTCHA detected — Google identified the runner as a bot"

    await try_dismiss_blocking(page)  # dismiss any in-page overlays

    # Did Google auto-redirect straight to the place panel?
    state, detail = await detect_page_state(page)
    if state == "place":
        print(f"    [nav] ✓ Auto-redirected to place panel")
        return True, ""

    # ── B. Follow first /maps/place/ href directly ─────────────────────────
    print(f"    [nav] On search page — attempting href extraction")
    try:
        # Wait a little longer for JS to finish rendering the results list
        await page.wait_for_timeout(2000)
        links = await page.query_selector_all('a[href*="/maps/place/"]')
        if links:
            href = await links[0].get_attribute("href") or ""
            if href:
                if href.startswith("/"):
                    href = "https://www.google.com" + href
                # Strip trailing fragment/params that prevent panel from loading
                href = href.split("?")[0]
                print(f"    [nav] Following place href: {href[:80]}")
                await page.goto(href, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(3500)
                state, detail = await detect_page_state(page)
                if state == "place":
                    print(f"    [nav] ✓ On place panel via href")
                    return True, ""
                print(f"    [nav] href nav landed on: {state} — {detail}")
    except Exception as e:
        print(f"    [nav] href strategy error: {e}")

    # ── C. Click first result card by CSS (multiple selector fallbacks) ────
    print(f"    [nav] Attempting result card click")
    for sel in [
        # Semantic / data-attribute selectors (survive CSS class renames)
        '[data-place-id]',
        'a[data-cid]',
        '[jsaction*="placeCard"]',
        # Structural selectors
        '[role="article"] a[href*="/maps/"]',
        'div[aria-label] > a[href*="/maps/place/"]',
        # Class-name selectors (may change but kept as last resort)
        '.Nv2PK', '.hfpxzc', '.Io6YTe', '.lI9IFe',
    ]:
        try:
            el = page.locator(sel).first
            if not await el.is_visible(timeout=1500):
                continue
            url_before = page.url
            await el.click()
            # Wait for URL to change (place panel loading is async)
            try:
                await page.wait_for_url(lambda u: "/maps/place/" in u, timeout=6000)
            except Exception:
                await page.wait_for_timeout(4000)
            state, detail = await detect_page_state(page)
            if state == "place":
                print(f"    [nav] ✓ On place panel via card click ({sel})")
                return True, ""
            if page.url != url_before:
                print(f"    [nav] Card click changed URL but not to place: {state}")
            # Try next selector
        except Exception:
            pass

    # ── D. Use stored maps_url from database ──────────────────────────────
    stored_url = await _get_stored_maps_url(name)
    if stored_url:
        print(f"    [nav] Trying stored maps_url: {stored_url[:80]}")
        try:
            await page.goto(stored_url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3500)
            state, detail = await detect_page_state(page)
            if state == "place":
                print(f"    [nav] ✓ On place panel via stored maps_url")
                return True, ""
        except Exception as e:
            print(f"    [nav] Stored URL navigation error: {e}")

    # All strategies exhausted
    final_state, final_detail = await detect_page_state(page)
    page_title = ""
    try:
        page_title = await page.title()
    except Exception:
        pass
    return False, (
        f"Could not navigate to place panel after 4 strategies. "
        f"Final state: {final_state} ({final_detail}) | URL: {page.url[:70]} | Title: {page_title[:50]}"
    )


# ---------------------------------------------------------------------------
# Reviews tab
# ---------------------------------------------------------------------------

async def go_to_reviews_tab(page, name: str) -> tuple[bool, str]:
    """
    Click the Reviews tab on a place panel.
    Returns (success, detail_message).

    Strategy order:
      1. aria-label CSS selectors (fastest when selector matches)
      2. Text/aria content scan across all tab/button containers
      3. Anchor links (#lrd= deep-links)
      4. JS brute-force: scan EVERY interactive element for "review" text
         — catches renamed/restructured tabs regardless of HTML shape
      5. If review feed is already visible without clicking, return success
    """
    current_url = page.url or ""
    try:
        title = await page.title()
    except Exception:
        title = "?"
    print(f"    [tab] {name} | URL: {current_url[:65]} | Title: {title[:45]}")

    # Give the place panel extra time to finish rendering tabs
    await page.wait_for_timeout(2000)

    # ── Strategy 1: aria-label CSS selectors ─────────────────────────────
    for sel in [
        'button[aria-label^="Reviews"]',
        'button[aria-label*=" reviews"]',
        'button[aria-label*="Reviews,"]',
        'button[aria-label*="reviews,"]',
        '[role="tab"][aria-label*="eview"]',
        'button[data-tab-index="1"]',
        'button[data-tab-index="2"]',
        '.hh2c6[data-tab-index="1"]',
        # Playwright get_by_role approach
        'button[aria-label*="Reviews "]',
        '[aria-label*="reviews "]',
    ]:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=1500):
                print(f"    [tab] Clicking: {sel}")
                await btn.click()
                await page.wait_for_timeout(2500)
                if await page.query_selector('[data-review-id]') or \
                   await page.query_selector('div[role="feed"]'):
                    print(f"    [tab] ✓ Reviews content confirmed")
                    return True, ""
                print(f"    [tab] ✓ Tab clicked (content pending)")
                return True, "tab clicked; content pending"
        except Exception:
            pass

    # ── Strategy 2: text/aria scan across tab/button containers ──────────
    for container in [
        '[role="tab"]',
        'button[data-tab-index]',
        '.hh2c6',
        '.RWPxGd button',
        'button[class*="hh2c6"]',
        'button[class*="Gpq6kf"]',
        'button[class*="Tab"]',
        '[role="tablist"] button',
        '[role="tablist"] [role="tab"]',
    ]:
        try:
            tabs = await page.query_selector_all(container)
            for tab in tabs:
                try:
                    txt  = (await tab.inner_text()).lower().strip()
                    aria = ((await tab.get_attribute("aria-label")) or "").lower()
                    combined = txt + " " + aria
                    if "review" in combined or any(lbl in combined for lbl in REVIEW_TAB_LABELS):
                        print(f"    [tab] Clicking by text: '{(txt or aria)[:40]}'")
                        await tab.click()
                        await page.wait_for_timeout(2500)
                        return True, f"text match: '{(txt or aria)[:40]}'"
                except Exception:
                    pass
        except Exception:
            pass

    # ── Strategy 3: anchor links ──────────────────────────────────────────
    for link_sel in ['a[href*="#lrd"]', 'a[aria-label*="eview"]', 'a[data-item-id*="review"]']:
        try:
            link = page.locator(link_sel).first
            if await link.is_visible(timeout=1000):
                print(f"    [tab] Clicking link: {link_sel}")
                await link.click()
                await page.wait_for_timeout(2500)
                if await page.query_selector('[data-review-id]'):
                    return True, f"link: {link_sel}"
        except Exception:
            pass

    # ── Strategy 4: JS brute-force scan ──────────────────────────────────
    # Scan EVERY interactive element on the page for "review" text.
    # Catches renamed tabs, divs acting as tabs, shadow-DOM-lite patterns,
    # and any structural change that breaks CSS selectors.
    print(f"    [tab] Attempting JS brute-force scan...")
    try:
        clicked_label = await page.evaluate("""() => {
            const SKIP = new Set(['write a review', 'add a review', 'leave a review',
                                  'write review', 'add review']);
            const els = Array.from(document.querySelectorAll(
                'button, [role="tab"], [role="button"], a, div[tabindex], span[tabindex]'
            ));
            for (const el of els) {
                const text = (
                    (el.innerText || el.textContent || '') + ' ' +
                    (el.getAttribute('aria-label') || '')
                ).toLowerCase().trim();
                if (!text.includes('review')) continue;
                if (SKIP.has(text)) continue;
                // Make sure it's actually visible
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                el.click();
                return text.slice(0, 60);
            }
            return null;
        }""")
        if clicked_label:
            print(f"    [tab] JS scan clicked: '{clicked_label}'")
            await page.wait_for_timeout(3000)
            if await page.query_selector('[data-review-id]') or \
               await page.query_selector('div[role="feed"]'):
                print(f"    [tab] ✓ Reviews content confirmed via JS scan")
                return True, f"JS scan: '{clicked_label}'"
            # Clicked something but feed not visible yet — still count as success
            return True, f"JS scan click: '{clicked_label}' (feed pending)"
    except Exception as e:
        print(f"    [tab] JS scan error: {e}")

    # ── Strategy 5: check if review content is already visible ───────────
    # Sometimes the Overview page already shows the reviews section inline.
    try:
        if await page.query_selector('[data-review-id]'):
            count = len(await page.query_selector_all('[data-review-id]'))
            print(f"    [tab] ✓ Reviews already visible in DOM ({count} elements)")
            return True, "reviews already in DOM"
    except Exception:
        pass

    # ── Failure: collect diagnostics ──────────────────────────────────────
    # Log every button/tab label and a snippet of the DOM to help diagnosis
    visible_labels: list[str] = []
    try:
        candidates = await page.query_selector_all(
            '[role="tab"], button[data-tab-index], .hh2c6, button[aria-label], button'
        )
        for el in candidates[:30]:
            try:
                txt  = (await el.inner_text()).strip()
                aria = (await el.get_attribute("aria-label") or "").strip()
                label = (txt or aria)[:50]
                if label and label not in visible_labels:
                    visible_labels.append(label)
            except Exception:
                pass
    except Exception:
        pass

    labels_str = ", ".join(visible_labels[:10]) if visible_labels else "none"
    detail = (
        f"Reviews tab not found after 5 strategies | "
        f"URL: {current_url[:60]} | "
        f"Elements found: [{labels_str}]"
    )
    print(f"    [tab] ✗ {detail}")
    return False, detail


# ---------------------------------------------------------------------------
# Sort + extract
# ---------------------------------------------------------------------------

async def sort_by_newest(page):
    for sel in ['button[aria-label*="Sort reviews"]', 'button[aria-label*="sort" i]', '.fxNQSd button']:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=2000):
                await btn.click()
                await page.wait_for_timeout(800)
                for nsel in ['[data-index="1"]', 'li:nth-child(2)',
                             '[aria-label*="Newest"]', 'li:has-text("Newest")']:
                    try:
                        newest = page.locator(nsel).first
                        if await newest.is_visible(timeout=1000):
                            await newest.click()
                            await page.wait_for_timeout(1500)
                            return
                    except Exception:
                        pass
                break
        except Exception:
            pass


async def extract_from_dom(page, seen_ids: set) -> list:
    """Extract reviews currently in the DOM, skipping any already in seen_ids."""
    new_reviews = []
    els = await page.query_selector_all('[data-review-id]')

    for sel in ['button[aria-label*="See more"]', 'button.w8nwRe']:
        try:
            btns = await page.query_selector_all(sel)
            for btn in btns:
                try:
                    await btn.click()
                    await page.wait_for_timeout(50)
                except Exception:
                    pass
        except Exception:
            pass

    for el in els:
        try:
            rid = await el.get_attribute("data-review-id") or ""
            if not rid or rid in seen_ids:
                continue
            seen_ids.add(rid)

            name = ""
            for sel in ['.d4r55', '.DHIhE']:
                ne = await el.query_selector(sel)
                if ne:
                    name = (await ne.inner_text()).strip()
                    if name:
                        break

            stars = 0
            for sel in ['[aria-label*="star"]', '.kvMYJc', 'span[role="img"]']:
                se = await el.query_selector(sel)
                if se:
                    aria = (await se.get_attribute("aria-label")) or ""
                    m = re.search(r'(\d)', aria)
                    if m:
                        stars = int(m.group(1))
                        break

            date_str = ""
            for sel in ['.rsqaWe', 'span[class*="date"]']:
                de = await el.query_selector(sel)
                if de:
                    date_str = (await de.inner_text()).strip()
                    if date_str:
                        break

            text = ""
            for sel in ['.MyEned span[jslog]', '.MyEned span:not([jslog])', '.wiI7pd span']:
                te = await el.query_selector(sel)
                if te:
                    text = (await te.inner_text()).strip()
                    if text:
                        break

            # Owner response — Strategy 1: JavaScript evaluation (resilient to CSS class churn)
            owner_resp = ""
            try:
                owner_resp = (await el.evaluate("""el => {
                    const HEADER = 'response from the owner';
                    const candidates = [
                        el.querySelector('.CDe7pd'),
                        el.querySelector('.mTHi3d'),
                        el.querySelector('[data-reply-id]'),
                    ].filter(Boolean);
                    if (candidates.length === 0) {
                        for (const node of el.querySelectorAll('*')) {
                            const t = (node.innerText || '').trim().toLowerCase();
                            if (t === HEADER && node.parentElement) {
                                candidates.push(node.parentElement);
                                break;
                            }
                        }
                    }
                    for (const section of candidates) {
                        const full = (section.innerText || '').trim();
                        const cleaned = full
                            .replace(/^response from the owner[\\s\\n]*/i, '')
                            .replace(/\\s*See (more|less)\\s*$/i, '')
                            .trim();
                        if (cleaned && cleaned.toLowerCase() !== HEADER) return cleaned;
                    }
                    return '';
                }""")) or ""
            except Exception:
                pass

            # Strategy 2: CSS selector fallback
            if not owner_resp:
                for sel in [
                    '.CDe7pd .MyEned span[jslog]', '.CDe7pd .MyEned span',
                    '.CDe7pd span', '.mTHi3d span', '[data-reply-id] span',
                ]:
                    re_el = await el.query_selector(sel)
                    if re_el:
                        candidate = (await re_el.inner_text()).strip()
                        if candidate and candidate.lower() != "response from the owner":
                            owner_resp = candidate
                            break

            if owner_resp:
                print(f"      [RESPONSE] Found for {name[:40]}")
            else:
                print(f"      [NO RESPONSE] {name[:40]}")

            if name or text:
                new_reviews.append({
                    "reviewer_name":  name,
                    "star_rating":    stars,
                    "review_date":    relative_to_date(date_str),
                    "review_text":    text,
                    "owner_response": owner_resp,
                    "review_url":     f"https://www.google.com/maps/reviews/{rid}" if rid else "",
                })
        except Exception:
            pass
    return new_reviews


async def scroll_and_extract(page, max_reviews: int) -> list:
    """Scroll the reviews feed and extract in batches to avoid Chrome GC crashes."""
    feed = None
    for sel in ['div[role="feed"]', '.m6QErb[role="feed"]', '.DxyBCb']:
        try:
            el = await page.query_selector(sel)
            if el:
                feed = el
                break
        except Exception:
            pass

    all_reviews = []
    seen_ids: set = set()
    prev_dom_count = 0
    stall = 0

    for _ in range(600):
        if feed:
            await feed.evaluate("el => el.scrollTop = el.scrollHeight")
        else:
            await page.keyboard.press("End")
        await page.wait_for_timeout(1100)

        dom_count = len(await page.query_selector_all('[data-review-id]'))
        new_in_dom = dom_count - len(seen_ids)

        if new_in_dom >= EXTRACT_EVERY or dom_count >= max_reviews:
            batch = await extract_from_dom(page, seen_ids)
            all_reviews.extend(batch)

        if dom_count >= max_reviews:
            break
        if dom_count == prev_dom_count:
            stall += 1
            if stall >= 5:
                break
        else:
            stall = 0
        prev_dom_count = dom_count

    final = await extract_from_dom(page, seen_ids)
    all_reviews.extend(final)
    return all_reviews


# ---------------------------------------------------------------------------
# Main scrape loop
# ---------------------------------------------------------------------------

async def scrape_location(context, loc: dict) -> tuple:
    """
    Scrape one location. Returns (reviews, error_message, maps_url).
    error_message is None on success; non-None means the scrape itself failed
    (so callers can distinguish "found 0 reviews" from "navigation failed").
    """
    name = loc["name"]
    print(f"\n  ── {name} ──")

    page = await context.new_page()
    await page.set_extra_http_headers({"Accept-Language": "en-US,en;q=0.9"})
    try:
        # ── Step 1: Navigate to place panel ──────────────────────────────
        print(f"    Step 1/4: Navigate to place panel")
        ok, nav_err = await navigate_to_place(page, loc)
        if not ok:
            await save_debug_snapshot(page, name, "nav-fail")
            print(f"    ✗ Navigation failed: {nav_err}")
            return [], nav_err, ""

        maps_url = page.url or ""
        if "/maps/search/" in maps_url:
            maps_url = ""
        print(f"    ✓ On place panel: {maps_url[:70]}")

        # ── Step 2: Open Reviews tab ──────────────────────────────────────
        print(f"    Step 2/4: Open Reviews tab")
        found, tab_detail = await go_to_reviews_tab(page, name)
        if not found:
            # One more attempt after an extra wait
            print(f"    → Waiting 5s and retrying Reviews tab...")
            await page.wait_for_timeout(5000)
            found, tab_detail = await go_to_reviews_tab(page, name)
            if not found:
                await save_debug_snapshot(page, name, "tab-fail")
                print(f"    ✗ Reviews tab: {tab_detail}")
                return [], tab_detail, maps_url

        # Update maps_url now that we're on the reviews sub-page
        maps_url = page.url or maps_url
        if "/maps/search/" in maps_url:
            maps_url = ""
        print(f"    ✓ Reviews tab open: {maps_url[:70]}")

        # ── Step 3: Sort newest first ─────────────────────────────────────
        print(f"    Step 3/4: Sort by newest")
        await sort_by_newest(page)

        # ── Step 4: Scroll + extract ──────────────────────────────────────
        print(f"    Step 4/4: Scroll and extract (max {MAX_SCROLL})")
        reviews = await scroll_and_extract(page, MAX_SCROLL)
        with_resp = sum(1 for r in reviews if r.get("owner_response"))
        print(f"    ✓ {len(reviews)} reviews, {with_resp} with owner response")
        return reviews, None, maps_url

    except Exception as e:
        print(f"    ✗ Exception: {e}")
        try:
            await save_debug_snapshot(page, name, "exception")
        except Exception:
            pass
        return [], str(e), ""
    finally:
        await page.close()


# ---------------------------------------------------------------------------
# CSV helpers
# ---------------------------------------------------------------------------

def load_existing() -> set:
    if not REVIEWS_CSV.exists():
        return set()
    keys = set()
    with REVIEWS_CSV.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            keys.add(dedup_key(r))
    return keys


def is_duplicate(row: dict, existing_keys: set) -> bool:
    return dedup_key(row) in existing_keys


def append_to_csv(new_rows: list):
    with REVIEWS_CSV.open(encoding="utf-8") as f:
        existing = list(csv.DictReader(f))

    def score(r):
        return (2 if r.get("owner_response") else 0) + (1 if r.get("review_text") else 0)

    best = {}
    for r in existing + new_rows:
        key = dedup_key(r)
        if key not in best or score(r) > score(best[key]):
            best[key] = r
    with REVIEWS_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES, quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(best.values())


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

def build_email_html(new_rows: list, failed_locs: list[dict] | None = None) -> str:
    """Build premium HTML email for the negative-review notification.
    Callers are expected to pass an already-filtered (1-2 star only) list --
    via digest_filters.get_new_negative_reviews() -- but this still re-checks
    every row itself before rendering, so a mistakenly-unfiltered array can
    never leak a 3-5 star review into the email (defense-in-depth, not the
    only guard). Reviews are NEVER truncated. failed_locs: list of
    {name, error} dicts."""
    import html as _html

    new_rows = [r for r in new_rows if digest_filters.is_negative_review_for_notification(r)]
    if not new_rows:
        return ""

    # ── Topic + action detection ─────────────────────────────────────────────
    _TOPIC_MAP = [
        ("Service",          ["server", "staff", "waiter", "waitress", "employee"]),
        ("Wrong Order",      ["wrong order", "wrong dish", "incorrect order", "messed up", "wrong item"]),
        ("Wait Time",        ["wait", "slow", "long time", "forever", "took too long"]),
        ("Refills",          ["refill", "refills"]),
        ("Food Quality",     ["cold food", "bland", "raw", "overcooked", "stale", "undercooked", "bad food"]),
        ("Cleanliness",      ["dirty", "filthy", "cockroach", "roach", "rat", "pest", "gross"]),
        ("Payment/Receipt",  ["card machine", "payment", "receipt", "cash", "card reader"]),
        ("Atmosphere",       ["atmosphere", "noise", "noisy", "loud", "crowded", "parking"]),
        ("Health Concern",   ["sick", "ill", "vomit", "food poison", "diarrhea", "hospital"]),
        ("Price / Value",    ["expensive", "overpriced", "overcharged"]),
        ("Staff Attitude",   ["rude", "hostile", "disrespectful", "unprofessional", "attitude"]),
    ]
    _ACTION_MAP = [
        (["server", "staff", "waiter", "waitress", "employee"],   "Identify the staff member involved and follow up with management."),
        (["wrong order", "wrong dish", "incorrect", "messed up"], "Review order accuracy procedures with the kitchen team."),
        (["refill"],                                               "Reinforce refill and table-check standards with front-of-house staff."),
        (["card machine", "payment", "receipt"],                   "Inspect payment terminals and ensure receipts are available on request."),
        (["dirty", "filthy", "cockroach", "roach", "rat", "pest"],"Schedule an immediate deep-clean and pest inspection."),
        (["sick", "food poison", "vomit", "hospital"],             "Escalate to management — potential food safety issue. Contact advertising@l3amigos.com."),
        (["wait", "slow", "long time", "forever"],                 "Review staffing levels and service pace during peak hours."),
        (["rude", "hostile", "disrespectful"],                     "Address customer service standards with the team."),
    ]

    def _detect_topics(text):
        if not text:
            return []
        lower = text.lower()
        return [t for t, kws in _TOPIC_MAP if any(kw in lower for kw in kws)][:6]

    def _actions(text, stars):
        if not text:
            return []
        lower = text.lower()
        found = [a for kws, a in _ACTION_MAP if any(kw in lower for kw in kws)]
        if int(stars or 0) == 1:
            found.append("Consider reaching out directly to the customer to offer a resolution.")
        return found[:5] or ["Draft a professional, empathetic reply on Google."]

    def _safe(s):
        return _html.escape(str(s or ""), quote=False)

    def _stars_bar(n):
        n = max(0, min(5, int(n or 0)))
        return (
            f'<span style="color:#f59e0b;font-size:17px;letter-spacing:2px">{"&#9733;" * n}</span>'
            f'<span style="color:#d1d5db;font-size:17px;letter-spacing:2px">{"&#9734;" * (5 - n)}</span>'
        )

    def _fmt_date(s):
        try:
            from datetime import date as _d
            return _d.fromisoformat(str(s or "")[:10]).strftime("%B %d, %Y")
        except Exception:
            return str(s or "Unknown date")

    def _nl2p(text):
        """HTML-escape text and convert newlines to paragraph/br tags without truncation."""
        escaped = _safe(text)
        normalized = re.sub(r'\n{2,}', '\n\n', escaped.strip())
        parts = [p.strip() for p in normalized.split('\n\n') if p.strip()]
        if not parts:
            return '<span style="color:#94a3b8;font-style:normal">No written content.</span>'
        if len(parts) == 1:
            return parts[0].replace('\n', '<br>')
        return ''.join(
            f'<p style="margin:0 0 12px 0">{p.replace(chr(10), "<br>")}</p>'
            for p in parts
        )

    def _star_theme(n):
        n = int(n or 0)
        if n <= 1: return '#dc2626', '#fff1f2', 'Very Negative'
        if n == 2: return '#f97316', '#fff7ed', 'Negative'
        if n == 3: return '#d97706', '#fffbeb', 'Mixed'
        if n == 4: return '#16a34a', '#f0fdf4', 'Positive'
        return '#15803d', '#f0fdf4', 'Very Positive'

    def _review_card(r):
        reviewer = _safe(r.get("reviewer_name") or "Anonymous")
        stars    = int(r.get("star_rating") or 0)
        date_s   = _fmt_date(r.get("review_date"))
        text     = (r.get("review_text") or "").strip()
        url      = r.get("review_url") or ""
        is_low   = stars <= 2

        accent, badge_bg, sentiment = _star_theme(stars)
        topics  = _detect_topics(text)
        actions = _actions(text, stars) if is_low else []

        chips = "".join(
            f'<span style="display:inline-block;background:#f0f9ff;color:#0369a1;'
            f'border:1px solid #bae6fd;border-radius:20px;padding:3px 12px;margin:3px;'
            f'font-size:12px;font-weight:600">{t}</span>'
            for t in topics
        ) if topics else '<span style="font-size:12px;color:#94a3b8;font-style:italic">None detected</span>'

        action_rows = "".join(
            '<tr>'
            '<td style="width:14px;vertical-align:top;padding:4px 0;color:#d97706;font-size:13px">&#8226;</td>'
            f'<td style="padding:4px 0 4px 8px;font-size:13px;color:#1e293b;line-height:1.55">{a}</td>'
            '</tr>'
            for a in actions
        )

        actions_section = (
            '<tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9">'
            '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
            'text-transform:uppercase;letter-spacing:.08em">Recommended Actions</p>'
            f'<table width="100%" cellpadding="0" cellspacing="0">{action_rows}</table>'
            '</td></tr>'
        ) if action_rows else ""

        view_link = (
            f'<a href="{_safe(url)}" '
            'style="display:inline-block;background:#0f172a;color:white;text-decoration:none;'
            'border-radius:7px;padding:9px 16px;font-size:12px;font-weight:600;margin-right:8px;'
            'margin-bottom:6px">&#128279;&nbsp;View Review</a>'
        ) if url else ""

        # Pre-compute to avoid backslash inside f-string expression
        no_text_fallback = '<span style="color:#94a3b8;font-style:normal">Rating only — no written review.</span>'
        review_body = _nl2p(text) if text else no_text_fallback

        return "".join([
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;'
            'border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;background:white;'
            'border-collapse:separate">',

            # Header row — reviewer + sentiment badge
            '<tr><td style="background:#0f172a;padding:16px 22px;border-radius:12px 12px 0 0">',
            '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
            f'<td><p style="margin:0 0 2px;font-size:14px;font-weight:700;color:white">{reviewer}</p>',
            f'<p style="margin:0;font-size:12px;color:#94a3b8">{date_s}</p></td>',
            '<td style="text-align:right;white-space:nowrap">',
            f'<span style="background:{badge_bg};color:{accent};border-radius:6px;'
            f'padding:5px 12px;font-size:12px;font-weight:700">{stars}&#9733;&nbsp;{sentiment}</span>',
            '</td></tr></table></td></tr>',

            # Stars bar row
            '<tr><td style="padding:8px 22px 10px;background:#f8fafc;border-bottom:1px solid #f1f5f9">',
            _stars_bar(stars),
            f'<span style="font-size:12px;color:#64748b;font-weight:600;vertical-align:middle;margin-left:8px">{stars} / 5</span>',
            '</td></tr>',

            # Full review — never truncated
            '<tr><td style="padding:16px 22px;border-bottom:1px solid #f1f5f9">',
            '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
            'text-transform:uppercase;letter-spacing:.08em">Full Review</p>',
            f'<div style="background:#f8fafc;border-left:3px solid {accent};'
            'border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;'
            'color:#1e293b;line-height:1.8;font-style:italic">',
            review_body,
            '</div></td></tr>',

            # Detected topics
            '<tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9">',
            '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
            'text-transform:uppercase;letter-spacing:.08em">Detected Topics</p>',
            f'<div>{chips}</div></td></tr>',

            # Recommended actions (low-star reviews only)
            actions_section,

            # Quick links
            f'<tr><td style="padding:14px 22px">{view_link}</td></tr>',

            '</table>',
        ])

    # ── Assemble email ───────────────────────────────────────────────────────
    by_loc = defaultdict(list)
    for r in new_rows:
        by_loc[r["location_name"]].append(r)

    total    = len(new_rows)
    low_star = sum(1 for r in new_rows if int(r.get("star_rating") or 0) <= 2)
    date_str = datetime.now().strftime("%B %d, %Y")
    year_now = datetime.now().year

    MAX_CARDS   = 15
    cards_built = 0
    overflow    = 0
    loc_sections = []

    # Low-star locations first, then alphabetical within each tier
    sorted_locs = sorted(
        by_loc.items(),
        key=lambda x: (-sum(1 for r in x[1] if int(r.get("star_rating") or 5) <= 2), x[0])
    )

    for loc_name, reviews in sorted_locs:
        # Within each location: lowest stars first
        sorted_revs = sorted(reviews, key=lambda r: int(r.get("star_rating") or 5))
        loc_cards = []
        for r in sorted_revs:
            if cards_built >= MAX_CARDS:
                overflow += 1
                continue
            loc_cards.append(_review_card(r))
            cards_built += 1
        if not loc_cards:
            continue
        safe_loc = _safe(loc_name)
        loc_sections.append(
            f'<p style="margin:28px 0 12px;font-size:11px;font-weight:700;color:#64748b;'
            f'text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #e2e8f0;'
            f'padding-bottom:8px">&#128205;&nbsp;{safe_loc}'
            f'<span style="font-size:11px;font-weight:400;color:#94a3b8;margin-left:6px">'
            f'({len(reviews)} new)</span></p>'
            + "".join(loc_cards)
        )

    overflow_note = (
        f'<p style="text-align:center;font-size:13px;color:#64748b;margin:0 0 24px;'
        f'padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">'
        f'&#43; {overflow} more review{"s" if overflow != 1 else ""} not shown — '
        f'open the dashboard to see all.</p>'
    ) if overflow > 0 else ""

    failure_block = ""
    if failed_locs:
        items_html = "".join(
            f"<li style='margin:4px 0;font-size:13px'>"
            f"<strong>{_safe(f['name'])}</strong> — "
            f"<span style='color:#555'>{_safe(f['error'][:200])}</span></li>"
            for f in failed_locs[:21]
        )
        failure_block = (
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">'
            '<tr><td style="background:#fff7ed;border-left:4px solid #f97316;'
            'padding:16px 20px;border-radius:0 8px 8px 0">'
            f'<p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#c2410c;'
            f'text-transform:uppercase">&#9888;&#65039;&nbsp;Scraper — '
            f'{len(failed_locs)} location(s) could not be scraped this run</p>'
            f'<ul style="margin:6px 0 0;padding-left:20px">{items_html}</ul>'
            '</td></tr></table>'
        )

    ls_badge = (
        f'<div style="background:#fff1f2;border:1.5px solid #fecaca;border-radius:8px;'
        f'padding:12px 16px;margin-bottom:20px;font-size:13px;color:#991b1b;font-weight:600">'
        f'&#9888;&#65039;&nbsp;{low_star} low-star review{"s" if low_star != 1 else ""} '
        f'{"require" if low_star != 1 else "requires"} a response — aim to reply within 24&nbsp;hours.'
        f'</div>'
    ) if low_star > 0 else ""

    return (
        '<!DOCTYPE html><html lang="en"><head>'
        '<meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
        f'<title>{total} New Negative Review{"s" if total != 1 else ""} — LTA Dashboard</title>'
        '</head>'
        '<body style="margin:0;padding:0;background:#f1f5f9;'
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;'
        '-webkit-text-size-adjust:100%">'
        '<div style="max-width:640px;margin:0 auto;padding:20px 12px">'

        '<div style="background:#0f172a;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center">'
        '<p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3px;'
        'color:#f59e0b;text-transform:uppercase">LTA Review Dashboard</p>'
        f'<h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:white;letter-spacing:-0.3px">'
        f'{total} New Negative Review{"s" if total != 1 else ""}</h1>'
        f'<p style="margin:0;font-size:12px;color:#64748b">{date_str}</p>'
        '</div>'

        '<div style="background:white;border-radius:0 0 14px 14px;padding:24px 28px 32px">'
        + failure_block
        + ls_badge
        + "".join(loc_sections)
        + overflow_note
        + '</div>'

        '<div style="text-align:center;padding:16px 0 4px">'
        f'<p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.6">'
        f'LTA Review Dashboard &mdash; Auto-generated notification<br>'
        f'&copy; {year_now} Future Marketing Studio. All rights reserved.</p>'
        '</div>'

        '</div>'
        '</body></html>'
    )


def write_github_output(new_count: int, negative_count: int, email_html: str):
    if not GITHUB_OUTPUT:
        print(f"\nResult: {new_count} new reviews found ({negative_count} new 1-2 star)")
        return
    with open(GITHUB_OUTPUT, "a") as f:
        f.write(f"new_count={new_count}\n")
        f.write(f"negative_count={negative_count}\n")
        delimiter = "EOF_EMAIL"
        f.write(f"email_html<<{delimiter}\n{email_html}\n{delimiter}\n")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main():
    from playwright.async_api import async_playwright

    print(f"Starting scrape: {datetime.now()} | LOCAL={LOCAL_MODE} | DEBUG={DEBUG_MODE}")
    if DEBUG_MODE:
        LOGS_DIR.mkdir(exist_ok=True)
        print(f"Debug snapshots → {LOGS_DIR}")

    existing = load_existing()
    print(f"Existing reviews in CSV: {len(existing)}")

    conn = db.get_connection()
    db.init_schema(conn)
    run_mode = "local" if LOCAL_MODE else "cloud"
    run_cur = conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status) VALUES (?, ?, 'running')",
        (datetime.now(timezone.utc).isoformat(), run_mode),
    )
    run_id = run_cur.lastrowid
    conn.commit()
    run_stats = {"attempted": 0, "succeeded": 0, "failed": 0, "new": 0, "edited": 0, "deleted": 0}
    run_errors = []
    failed_locs: list[dict] = []

    all_scraped = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=not LOCAL_MODE,
            args=[
                # Reduce signals that identify the browser as headless/automated.
                # Google Maps renders a stripped page for detected bots, which
                # removes the Reviews tab from the DOM entirely.
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-popup-blocking",
            ],
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            # Real Chrome 137 UA — prevents Google from serving the stripped Maps UI
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/137.0.0.0 Safari/537.36"
            ),
        )
        # Remove the navigator.webdriver flag that headless Chrome exposes
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
        )
        for loc in LOCATIONS:
            run_stats["attempted"] += 1
            loc_started = datetime.now(timezone.utc)
            reviews, error, maps_url = await scrape_location(context, loc)
            duration_ms = int((datetime.now(timezone.utc) - loc_started).total_seconds() * 1000)

            loc_rows = [{
                "location_name":  loc["name"],
                "city":           loc["city"],
                "reviewer_name":  r["reviewer_name"],
                "review_date":    r["review_date"],
                "star_rating":    r["star_rating"],
                "review_text":    r["review_text"],
                "owner_response": r["owner_response"],
                "review_url":     r["review_url"],
            } for r in reviews]
            all_scraped.extend(loc_rows)

            location_id = db.get_or_create_location(
                conn, loc["name"], loc["city"], db.get_brand(loc["name"]), loc["search"],
                maps_url=maps_url,
            )
            now_iso = datetime.now(timezone.utc).isoformat()
            scraped_keys = set()
            window_min_date = None
            loc_new = loc_edited = 0
            for row in loc_rows:
                db_row = dict(row)
                db_row["star_rating"] = row["star_rating"] or None
                key = db.dedup_key(loc["name"], db_row)
                scraped_keys.add(key)
                if row["review_date"] and (window_min_date is None or row["review_date"] < window_min_date):
                    window_min_date = row["review_date"]
                result = db.upsert_review(conn, location_id, loc["name"], db_row, now_iso)
                if result == "new":
                    loc_new += 1
                elif result == "edited":
                    loc_edited += 1

            loc_deleted = (
                db.detect_deletions(conn, location_id, scraped_keys, window_min_date, now_iso)
                if window_min_date else 0
            )

            if error:
                run_stats["failed"] += 1
                run_errors.append(f"{loc['name']}: {error}")
                failed_locs.append({"name": loc["name"], "error": error})
            else:
                run_stats["succeeded"] += 1
            run_stats["new"]     += loc_new
            run_stats["edited"]  += loc_edited
            run_stats["deleted"] += loc_deleted

            conn.execute(
                """INSERT INTO scraper_run_locations
                   (run_id, location_id, status, reviews_found, reviews_new, error_message, duration_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (run_id, location_id, "error" if error else "ok",
                 len(reviews), loc_new, error, duration_ms),
            )
            conn.commit()
        await browser.close()

    run_status = "ok" if run_stats["failed"] == 0 else ("partial" if run_stats["succeeded"] > 0 else "failed")
    conn.execute(
        """UPDATE scraper_runs SET finished_at = ?, status = ?, locations_attempted = ?,
           locations_succeeded = ?, locations_failed = ?, new_reviews_count = ?,
           edited_reviews_count = ?, deleted_reviews_count = ?, error_summary = ?
           WHERE id = ?""",
        (datetime.now(timezone.utc).isoformat(), run_status, run_stats["attempted"],
         run_stats["succeeded"], run_stats["failed"], run_stats["new"], run_stats["edited"],
         run_stats["deleted"], "; ".join(run_errors) if run_errors else None, run_id),
    )
    conn.commit()
    conn.close()
    print(f"\nSQLite run #{run_id}: {run_stats} | status={run_status}")

    new_rows = []
    for r in all_scraped:
        key = dedup_key(r)
        if key not in existing:
            new_rows.append(r)
            existing.add(key)

    print(f"New reviews found: {len(new_rows)}")

    # Storage/CSV keep every rating, unfiltered -- notification filtering
    # is a completely separate concern applied only below, never here.
    new_negative_rows = digest_filters.get_new_negative_reviews(new_rows)
    excluded_count = len(new_rows) - len(new_negative_rows)
    print(f"New 1-2 star reviews: {len(new_negative_rows)} "
          f"({excluded_count} excluded, 3-5 star)")
    print(f"Negative-review email: {'will be sent' if new_negative_rows else 'skipped (no new 1-2 star reviews)'}")

    if new_rows:
        append_to_csv(new_rows)
        print(f"Updated {REVIEWS_CSV}")
        email_html = build_email_html(new_negative_rows, failed_locs if failed_locs else None)
        write_github_output(len(new_rows), len(new_negative_rows), email_html)
    else:
        write_github_output(0, 0, "")

    if LOCAL_MODE:
        import subprocess
        print("\nPushing to GitHub...")
        subprocess.run("git add dashboard/reviews.csv dashboard/reviews.db", shell=True, cwd=BASE_DIR)
        msg = f"update: {len(new_rows)} new reviews" if new_rows else "update: no new reviews"
        subprocess.run(f'git commit -m "{msg}"', shell=True, cwd=BASE_DIR)
        subprocess.run("git push", shell=True, cwd=BASE_DIR)
        print("\nDeploying to Vercel...")
        subprocess.run("vercel --prod --yes", shell=True, cwd=BASE_DIR / "dashboard")

        print("\n")
        print("=" * 50)
        if new_rows:
            from collections import Counter
            print(f"  RESULT: {len(new_rows)} NEW REVIEWS FOUND")
            print("-" * 50)
            for loc_name, cnt in Counter(r["location_name"] for r in new_rows).most_common():
                print(f"  {cnt:4d}  {loc_name}")
        else:
            print("  RESULT: No new reviews since last run.")
        print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())
