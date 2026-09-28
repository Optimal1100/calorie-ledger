# Calorie Ledger

A calorie and macro tracker that installs on an iPhone home screen. Plain HTML, CSS and JavaScript with no build step.

- **Food search**: a built-in list of common foods, plus online search of USDA FoodData Central (generic and branded foods).
- **Barcode scanner**: live camera scanning (ZXing), looked up in Open Food Facts first, then USDA's branded foods.
- **Meal photos**: Claude estimates each item's calories and macros. This needs your own Anthropic API key, entered in the app's settings.
- **Storage**: everything stays on the device (localStorage). Use Export backup to keep a copy.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

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

Edit the files, then commit and push. Opening the app while online picks up the new version. If you change anything other than `index.html`, also bump `CACHE` in `sw.js`.

## Credits

Barcode decoding: [ZXing](https://github.com/zxing-js/library) (Apache 2.0, in `vendor/`). Food data: [Open Food Facts](https://world.openfoodfacts.org) (ODbL) and [USDA FoodData Central](https://fdc.nal.usda.gov) (public domain).
