# Calorie Ledger

A calorie and macro tracker that installs on an iPhone home screen. Plain HTML, CSS and JavaScript modules with no build step.

- `index.html` markup, `css/app.css` the design system, `js/app.js` the app, `js/core.js` pure logic (number input, units and portions, nutrition maths, AI result validation, sync merge), `js/ai.js` the Gemini/Claude client.

- **Food search**: the Swedish Food Agency's food database (2,600 foods, Swedish and English names, full micronutrients) bundled in `data/livsmedel.json` and searched on the device, plus online search of USDA FoodData Central.
- **Barcode scanner**: live camera scanning (ZXing). Looked up in a bundled table of Swedish products from Open Food Facts (`data/barcodes-se.json`), then Open Food Facts live, then USDA's branded foods.
- **Meal photos and descriptions**: the AI identifies each component and estimates its edible grams and nutrition per 100 g; the app does the arithmetic, swaps in Livsmedelsverket values where a component clearly matches, and shows an editable review (grams per item, whole-portion scale, redo with a correction) before anything is logged. A failed or unusable answer is shown as an error, never as an invented estimate. Uses a free Google Gemini key (aistudio.google.com/apikey) entered in Settings, or an Anthropic key if you set one.
- **Weight log**: comma or point decimals, trend chart, synced with the food log.
- **Storage**: everything stays on the device (localStorage). Use Export backup to keep a copy.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Tests

With the local server running, open http://localhost:8765/tests/ in a browser. It runs the core logic tests and end-to-end checks of the app in an iframe (AI answers are mocked, so no key or cost). Your data for that origin is backed up and restored.

`tests/ai-eval.html` measures real photo accuracy: pick your own photos, enter a reference (weighed or from a label), and run. It uses the key saved in the app on that browser and costs one AI request per photo.

## Publish on GitHub Pages

1. Create an empty public repo named `calorie-ledger` on github.com.
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<your-username>/calorie-ledger.git
   git push -u origin main
   ```
3. In the repo, open Settings › Pages. Set Source to "Deploy from a branch", branch `main`, folder `/ (root)`, then Save.
4. After a minute the app is live at `https://<your-username>.github.io/calorie-ledger/`.

## Install on iPhone

Open the link in Safari, tap Share, then **Add to Home Screen**.

## Updating

Edit the files, then commit and push. Opening the app while online picks up the new version: the page, scripts and styles load network-first. Bump `CACHE` in `sw.js` when you add or rename files so the offline copy includes them.

## Refreshing the bundled data

```bash
python3 tools/build_livsmedel.py
python3 tools/build_barcodes_se.py
```

A GitHub Actions workflow (`.github/workflows/refresh-data.yml`) runs both scripts every Monday and commits the result if anything changed. The app picks up new data on its own the next time it's opened; no `CACHE` bump is needed for data files.

## Credits

Barcode decoding: [ZXing](https://github.com/zxing-js/library) (Apache 2.0, in `vendor/`). Food data: [Livsmedelsverkets livsmedelsdatabas](https://www.livsmedelsverket.se/livsmedelsdatabasen) (CC BY 4.0), [Open Food Facts](https://world.openfoodfacts.org) (ODbL) and [USDA FoodData Central](https://fdc.nal.usda.gov) (public domain).
