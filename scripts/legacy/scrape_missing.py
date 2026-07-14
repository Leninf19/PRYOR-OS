"""
Scrape the 6 locations that failed in the first pass.
- Rio Luna: fixed search/tab detection
- 5 large locations: capped at 500 reviews to avoid heap overflow
"""
import sys
import os
os.environ["PYTHONUTF8"] = "1"
sys.stdout.reconfigure(encoding="utf-8")

import asyncio
import csv
import re
from datetime import datetime, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent
OUTPUT_CSV = BASE_DIR / "scraped_missing.csv"

LOCATIONS = [
    {"name": "Rio Luna Tacos & Tequila",       "city": "Saginaw",        "search": "Rio Luna Tacos Tequila Saginaw MI", "max_reviews": 600},
    {"name": "Los Tres Amigos Northville",      "city": "Northville",     "search": "Los Tres Amigos Northville MI",     "max_reviews": 500},
    {"name": "Los Tres Amigos Michigan Center", "city": "Michigan Center","search": "Los Tres Amigos Michigan Center MI", "max_reviews": 500},
    {"name": "Los Tres Amigos Canton",          "city": "Canton",         "search": "Los Tres Amigos Canton MI",         "max_reviews": 500},
    {"name": "Casa Tequila Brighton",           "city": "Brighton",       "search": "Casa Tequila Brighton MI",          "max_reviews": 500},
    {"name": "Casa Tequila Chicago",            "city": "Chicago",        "search": "Casa Tequila Chicago IL",           "max_reviews": 500},
]

FIELDNAMES = ["location_name", "city", "reviewer_name", "review_date",
              "star_rating", "review_text", "owner_response", "review_url"]


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


async def dismiss_dialogs(page):
    for sel in ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]',
                'form[action*="consent"] button', 'button:has-text("Accept")']:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=1000):
                await btn.click()
                await page.wait_for_timeout(500)
        except Exception:
            pass


async def expand_review_text(page):
    for sel in ['button[aria-label*="See more"]', 'button.w8nwRe']:
        try:
            btns = await page.query_selector_all(sel)
            for btn in btns:
                try:
                    await btn.click()
                    await page.wait_for_timeout(60)
                except Exception:
                    pass
        except Exception:
            pass


async def extract_reviews(page) -> list:
    reviews = []
    seen_ids = set()

    els = await page.query_selector_all('[data-review-id]')
    for el in els:
        try:
            rid = await el.get_attribute("data-review-id") or ""
            if rid in seen_ids:
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
            review_date = relative_to_date(date_str)

            text = ""
            for sel in ['.MyEned span[jslog]', '.MyEned span:not([jslog])', '.wiI7pd span']:
                te = await el.query_selector(sel)
                if te:
                    text = (await te.inner_text()).strip()
                    if text:
                        break

            owner_resp = ""
            for sel in ['.CDe7pd .MyEned span[jslog]', '.CDe7pd span']:
                re_el = await el.query_selector(sel)
                if re_el:
                    owner_resp = (await re_el.inner_text()).strip()
                    if owner_resp:
                        break

            if name or text:
                reviews.append({
                    "reviewer_name":  name,
                    "star_rating":    stars,
                    "review_date":    review_date,
                    "review_text":    text,
                    "owner_response": owner_resp,
                    "review_url":     f"https://www.google.com/maps/reviews/{rid}" if rid else "",
                })
        except Exception as e:
            pass

    return reviews


async def go_to_reviews_tab(page):
    for sel in ['button[aria-label^="Reviews"]', 'button[aria-label*=" reviews"]',
                '[role="tab"]:has-text("Reviews")']:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=3000):
                await btn.click()
                await page.wait_for_timeout(1500)
                return True
        except Exception:
            pass

    tabs = await page.query_selector_all('[role="tab"], button[data-tab-index]')
    for tab in tabs:
        try:
            txt = (await tab.inner_text()).lower()
            if "review" in txt:
                await tab.click()
                await page.wait_for_timeout(1500)
                return True
        except Exception:
            pass

    return False


async def sort_by_newest(page):
    for sel in ['button[aria-label*="Sort reviews"]', 'button[aria-label*="sort" i]',
                '.fxNQSd button']:
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


async def scroll_all_reviews(page, max_reviews=500):
    """Scroll until no more reviews load or max_reviews reached."""
    feed = None
    for sel in ['div[role="feed"]', '.m6QErb[role="feed"]', '.DxyBCb']:
        try:
            el = await page.query_selector(sel)
            if el:
                feed = el
                break
        except Exception:
            pass

    prev = 0
    stall = 0
    for i in range(300):
        if feed:
            await feed.evaluate("el => el.scrollTop = el.scrollHeight")
        else:
            await page.keyboard.press("End")
        await page.wait_for_timeout(1200)

        count = len(await page.query_selector_all('[data-review-id]'))
        if i % 10 == 0:
            print(f"    scroll {i}: {count} reviews")

        if count >= max_reviews:
            print(f"    -> reached cap of {max_reviews}, stopping")
            break

        if count == prev:
            stall += 1
            if stall >= 4:
                break
        else:
            stall = 0
        prev = count

    return count


async def click_first_result(page):
    """If on a search results page, click the first listing."""
    for sel in ['.Nv2PK', '.hfpxzc', 'a[href*="/maps/place/"]']:
        try:
            first = page.locator(sel).first
            if await first.is_visible(timeout=2000):
                await first.click()
                await page.wait_for_timeout(2500)
                print("  -> clicked first search result")
                return True
        except Exception:
            pass
    return False


async def scrape_location(browser, loc) -> list:
    name = loc["name"]
    city = loc["city"]
    search = loc["search"]
    max_reviews = loc.get("max_reviews", 500)

    print(f"\n{'='*60}")
    print(f"  {name}  [{city}]  (max {max_reviews} reviews)")
    print(f"{'='*60}")

    page = await browser.new_page()
    await page.set_extra_http_headers({"Accept-Language": "en-US,en;q=0.9"})

    try:
        url = "https://www.google.com/maps/search/" + search.replace(" ", "+")
        print(f"  -> {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        await dismiss_dialogs(page)

        # Click first result if on search results page
        await click_first_result(page)
        await page.wait_for_timeout(1000)

        if not await go_to_reviews_tab(page):
            # Try clicking a second time after a longer wait
            await page.wait_for_timeout(2000)
            if not await go_to_reviews_tab(page):
                print("  [SKIP] Could not find Reviews tab - skipping")
                return []

        print("  -> on Reviews tab")
        await sort_by_newest(page)
        print("  -> sorted by newest")

        total = await scroll_all_reviews(page, max_reviews=max_reviews)
        print(f"  -> finished scrolling: {total} reviews loaded")

        await expand_review_text(page)
        reviews = await extract_reviews(page)
        print(f"  [OK] extracted {len(reviews)} reviews")
        return reviews

    except Exception as e:
        print(f"  [ERR] {e}")
        return []
    finally:
        await page.close()


async def main():
    from playwright.async_api import async_playwright

    all_rows = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=30)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )

        for loc in LOCATIONS:
            reviews = await scrape_location(context, loc)
            for r in reviews:
                all_rows.append({
                    "location_name":  loc["name"],
                    "city":           loc["city"],
                    "reviewer_name":  r["reviewer_name"],
                    "review_date":    r["review_date"],
                    "star_rating":    r["star_rating"],
                    "review_text":    r["review_text"],
                    "owner_response": r["owner_response"],
                    "review_url":     r["review_url"],
                })

        await browser.close()

    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\n{'='*60}")
    print(f"Done: {len(all_rows)} total reviews -> {OUTPUT_CSV}")
    from collections import Counter
    for loc_name, cnt in Counter(r["location_name"] for r in all_rows).most_common():
        print(f"  {cnt:5d}  {loc_name}")


if __name__ == "__main__":
    asyncio.run(main())
