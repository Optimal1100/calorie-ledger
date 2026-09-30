#!/usr/bin/env python3
"""
Download every product with a Swedish barcode, or tagged as sold in Sweden, from
Open Food Facts (ODbL) that has nutrition data, and write a compact barcode table to data/barcodes-se.json so
the app can recognise Swedish barcodes instantly and offline.

    python3 tools/build_barcodes_se.py

Standard library only. Takes under a minute.
"""
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SEARCH = "https://search.openfoodfacts.org/search"
FIELDS = "code,product_name_sv,product_name,brands,serving_size,serving_quantity,nutriments"
# Two groups: every product with a Swedish barcode (GS1 prefixes 730-739), whatever country it is tagged with, plus
# foreign-barcode products tagged as sold in Sweden. The search service returns at most 10,000 results per query,
# so the Swedish barcodes are fetched one prefix at a time.
SLICES = [f"code:{p}*" for p in range(730, 740)] + ['countries_tags:"en:sweden" AND NOT code:73*']
OUT = Path(__file__).resolve().parent.parent / "data" / "barcodes-se.json"


def get(query, page, tries=5):
    url = SEARCH + "?" + urllib.parse.urlencode({"q": query, "page_size": 1000, "page": page, "fields": FIELDS})
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "calorie-ledger-build/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == tries - 1:
                raise
            print(f"  {e}; retrying", flush=True)
            time.sleep(10 * (i + 1))


def num(v, mul=1.0, digits=1):
    return round(v * mul, digits) if isinstance(v, (int, float)) else None


def main():
    products = {}
    for query in SLICES:
        page = 1
        while True:
            data = get(query, page)
            batch = data.get("hits") or []
            for p in batch:
                n = p.get("nutriments") or {}
                code = "".join(ch for ch in str(p.get("code") or "") if ch.isdigit())
                kcal = n.get("energy-kcal_100g")
                if kcal is None and isinstance(n.get("energy_100g"), (int, float)):
                    kcal = n["energy_100g"] / 4.184
                name = (p.get("product_name_sv") or p.get("product_name") or "").strip()
                brands = p.get("brands") or ""
                brand = (brands[0] if isinstance(brands, list) and brands else str(brands).split(",")[0] if isinstance(brands, str) else "").strip()
                if not code or not isinstance(kcal, (int, float)) or kcal > 950 or not (name or brand):
                    continue
                if brand and brand.lower() not in name.lower():
                    name = f"{brand} {name}".strip()
                sq = p.get("serving_quantity")
                try:
                    sq = round(float(sq), 1) if sq not in (None, "") else None
                except (TypeError, ValueError):
                    sq = None
                products[code] = [
                    name[:90], round(kcal), num(n.get("proteins_100g")) or 0, num(n.get("carbohydrates_100g")) or 0, num(n.get("fat_100g")) or 0,
                    sq, (str(p.get("serving_size") or "")[:30] if sq else ""),
                    num(n.get("fiber_100g")), num(n.get("sugars_100g")), num(n.get("saturated-fat_100g")), num(n.get("sodium_100g"), 1000, 0),
                ]
            print(f"{query[-32:]} page {page}/{data.get('page_count')}: {len(products)} kept so far", flush=True)
            if page >= (data.get("page_count") or 1) or not batch:
                break
            page += 1
            time.sleep(1)
        if data.get("count", 0) >= 10000 and not data.get("is_count_exact", True):
            print("  WARNING: this slice has more than 10,000 products; some were missed.")
    if len(products) < 10000:
        sys.exit(f"Only {len(products)} products came back; keeping the existing file.")
    products = dict(sorted(products.items()))
    if OUT.exists():
        try:
            if json.loads(OUT.read_text()).get("products") == products:
                print("No changes; existing file kept.")
                return 0
        except ValueError:
            pass
    payload = {
        "source": "Open Food Facts (Swedish barcodes and products sold in Sweden)", "license": "ODbL", "built": dt.date.today().isoformat(), "per": "100 g",
        "fields": ["name", "kcal", "p", "c", "f", "serving_g", "serving", "fiber", "sugar", "satfat", "sodium_mg"],
        "products": products,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {len(products)} products to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
