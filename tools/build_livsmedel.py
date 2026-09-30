#!/usr/bin/env python3
"""
Download the Swedish Food Agency's food composition database (Livsmedelsverkets
livsmedelsdatabas, CC BY 4.0) and write a compact copy to data/livsmedel.json
for the app to search offline.

    python3 tools/build_livsmedel.py

Standard library only. Takes a few minutes (one request per food).
"""
import concurrent.futures as cf
import datetime as dt
import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1"
OUT = Path(__file__).resolve().parent.parent / "data" / "livsmedel.json"

# App field -> EuroFIR code(s), summed. All values are per 100 g edible portion.
FIELDS = [
    ("p", ["PROT"]), ("c", ["CHO"]), ("f", ["FAT"]),
    ("fiber", ["FIBT"]), ("sugar", ["SUGAR"]), ("satfat", ["FASAT"]),
    ("sodium", ["NA"]), ("potassium", ["K"]), ("calcium", ["CA"]), ("iron", ["FE"]),
    ("magnesium", ["MG"]), ("zinc", ["ZN"]), ("vitc", ["VITC"]), ("vitd", ["VITD"]),
    ("b12", ["VITB12"]), ("vita", ["VITA"]), ("folate", ["FOL"]),
    ("omega3", ["F18:3", "F20:5", "F22:5", "F22:6"]),
]


def get(path, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(API + path, headers={"Accept": "application/json", "User-Agent": "calorie-ledger-build"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read())
        except Exception as e:  # network hiccup: back off and retry
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def food_list(lang):
    out, offset = {}, 0
    while True:
        page = get(f"/livsmedel?offset={offset}&limit=500&sprak={lang}")
        for f in page["livsmedel"]:
            out[f["nummer"]] = f["namn"].strip()
        offset += page["_meta"]["count"]
        if offset >= page["_meta"]["totalRecords"] or not page["_meta"]["count"]:
            return out


def nutrients(num):
    vals, kcal = {}, None
    for n in get(f"/livsmedel/{num}/naringsvarden?sprak=1"):
        code, v = n.get("euroFIRkod"), n.get("varde")
        if not isinstance(v, (int, float)):
            continue
        if code == "ENERC":
            if n.get("enhet") == "kcal":
                kcal = v
        else:
            vals[code] = v
    row = [kcal]
    for _, codes in FIELDS:
        present = [vals[c] for c in codes if c in vals]
        row.append(round(sum(present), 3) if present else None)
    return row


def main():
    print("Fetching food names…")
    sv, en = food_list(1), food_list(2)
    nums = sorted(sv)
    print(f"{len(nums)} foods. Fetching nutrients…")
    rows, done = {}, 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        for num, row in zip(nums, pool.map(nutrients, nums)):
            rows[num] = row
            done += 1
            if done % 250 == 0:
                print(f"  {done}/{len(nums)}")
    foods = []
    for num in nums:
        row = rows[num]
        if row[0] is None:
            continue
        name_en = en.get(num, "")
        foods.append([num, sv[num], name_en if name_en != sv[num] else ""] + row)
    payload = {
        "source": "Livsmedelsverkets livsmedelsdatabas",
        "license": "CC BY 4.0",
        "built": dt.date.today().isoformat(),
        "per": "100 g",
        "fields": ["nummer", "sv", "en", "kcal"] + [k for k, _ in FIELDS],
        "foods": foods,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {len(foods)} foods to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
