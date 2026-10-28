// Pure logic shared by the app and the tests: number input, units and portions, nutrition maths,
// AI result validation and the device-sync merge. Nothing in here touches the DOM or storage.

// ---------- numbers ----------
// The decimal separator this browser uses ("," in Sweden, "." in the US).
export const LOCALE_DECIMAL = (1.5).toLocaleString().replace(/\d/g, "").charAt(0) || ".";

// Read a number the way a person types it: "72,5", "72.5", " 1 250 ", "1.250,5" and "1,250.5" all work.
// Returns null for an empty field and NaN for anything that isn't a number, so callers can tell the two apart.
export function parseDecimal(raw, localeDecimal = LOCALE_DECIMAL){
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  let s = String(raw).trim().replace(/[\s  ']/g, "").replace(/[−–]/g, "-").replace(/^\+/, "");
  if (!s) return null;
  const commas = (s.match(/,/g) || []).length, dots = (s.match(/\./g) || []).length;
  // Thousands separators only count in proper groups of three ("1.250.000"), so "1..2" stays invalid.
  const grouped = (t, sep) => new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(t);
  if (commas && dots) {
    // Both present: whichever comes last is the decimal separator, the other groups thousands.
    const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".", thou = dec === "," ? "." : ",";
    const [whole, frac] = [s.slice(0, s.lastIndexOf(dec)), s.slice(s.lastIndexOf(dec) + 1)];
    if (!grouped(whole, thou) || frac.includes(thou)) return NaN;
    s = whole.split(thou).join("") + "." + frac;
  } else if (commas > 1 || dots > 1) {
    if (!grouped(s, commas ? "," : ".")) return NaN;
    s = s.replace(/[.,]/g, "");                     // 1.250.000 or 1,250,000
  } else if (commas === 1) {
    // "72,5" is a decimal. "1,250" is a thousands group only where "." is this device's decimal separator.
    s = /^-?\d{1,3},\d{3}$/.test(s) && localeDecimal === "." ? s.replace(",", "") : s.replace(",", ".");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

// Validate a typed amount. Returns {value} or {error} with a short message for the field.
export function readAmount(raw, {min = 0, max = Infinity, required = false, allowZero = true, localeDecimal} = {}){
  const v = parseDecimal(raw, localeDecimal);
  if (v === null) return required ? {error: "Required"} : {value: null};
  if (Number.isNaN(v)) return {error: "Enter a number"};
  if (v < 0) return {error: "Can't be negative"};
  if (!allowZero && v === 0) return {error: "Must be more than 0"};
  if (v < min) return {error: `At least ${toInput(min)}`};
  if (v > max) return {error: `At most ${toInput(max)}`};
  return {value: v};
}

// A number as it should appear inside an input: no grouping, the device's decimal separator, no trailing zeros.
export const toInput = (n, maxFrac = 2) => n == null || !Number.isFinite(+n) ? "" :
  (+n).toLocaleString(undefined, {maximumFractionDigits: maxFrac, useGrouping: false});
export const round1 = n => Math.round((+n || 0) * 10) / 10;
export const round0 = n => Math.round(+n || 0);
// Grams shown to a person: whole grams, or one decimal under 10 g.
export const roundGrams = g => g < 10 ? round1(g) : Math.round(g);

// ---------- food search ----------
export const fold = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const words = q => fold(q).replace(/[^\p{L}\p{N}%.]+/gu, " ").split(" ").filter(Boolean);
// Search a list of foods with {name, en, key}. Best first: name starts with the query, then a word starts with it, then anywhere.
export function searchFoods(foods, q, limit = 10){
  const fq = fold(q).trim(), ws = words(q), hits = [];
  if (!ws.length) return [];
  for (const f of foods) {
    const key = f.key || fold(f.name + " | " + (f.en || ""));
    if (!ws.every(w => key.includes(w))) continue;
    const sv = fold(f.name), en = fold(f.en);
    const rank = sv.startsWith(fq) || en.startsWith(fq) ? 0 : ws.every(w => (" " + key.replace(/[^\p{L}\p{N}%.]+/gu, " ")).includes(" " + w)) ? 1 : 2;
    hits.push([rank * 1000 + Math.min(f.name.length, 999), f]);
  }
  return hits.sort((x, y) => x[0] - y[0]).slice(0, limit).map(h => h[1]);
}

// ---------- portions ----------
// Typical edible weights for household measures, so foods open in a natural unit (1 banana, 2 slices, 1 glass)
// instead of 100 g. Matched against the food's English and Swedish names. Weights are approximate and always shown in grams too.
// [pattern, portions [label, grams], options]  options.count: open in the first portion; options.g: default gram amount; options.ml: grams per ml for drinks.
const P = (re, portions, opts = {}) => ({re, portions, ...opts});
export const PORTION_HINTS = [
  P(/^(banana|banan)\b(?! (dried|deep|chips|torkad|friterad))/, [["medium banana", 120], ["small banana", 90], ["large banana", 150]], {count: true}),
  P(/^(apple|apples|äpple)\b(?! (dried|canned|juice|cake|pie|sauce|torkat|konserv|juice|kaka|paj|mos))/, [["medium apple", 170], ["small apple", 130], ["large apple", 220]], {count: true}),
  P(/^(pear|päron)\b(?! (dried|canned|torkat|konserv))/, [["medium pear", 170]], {count: true}),
  P(/^(orange|apelsin)\b(?! (zest|salad|juice|skal|sallad|juice))/, [["medium orange", 130]], {count: true}),
  P(/^(kiwi)/, [["kiwi", 75]], {count: true}),
  P(/^(mandarin|clementine|klementin)/, [["clementine", 60]], {count: true}),
  P(/^(peach|persika|nectarine|nektarin)\b(?! (canned|konserv))/, [["medium peach", 140]], {count: true}),
  P(/^(avocado|avokado)\b(?! frozen)/, [["half avocado", 70], ["whole avocado", 140]], {count: true}),
  P(/^(tomato|tomat)\b(?! (canned|juice|pur|pulp|ketchup|sauce|konserv|juice|pur|krossad|sås))/, [["medium tomato", 100], ["cherry tomato", 15]], {count: true}),
  P(/^(carrot|morot)\b(?! (canned|juice|in |konserv|juice|i ))/, [["medium carrot", 70]], {count: true}),
  P(/^(cucumber|gurka)\b(?! (pickled|fermented|inlagd))/, [["slice", 7], ["whole cucumber", 350]], {g: 50}),
  P(/^(egg|ägg)\b(?! (noodle|yolk|white|sauce|nudl|gula|vita|sås))/, [["egg", 50], ["large egg", 60]], {count: true}),
  P(/^(crisp ?bread|knäckebröd|hårt bröd)/, [["slice", 12]], {count: true}),
  P(/^(bread|bröd|toast|rostbröd|limpa|loaf)\b(?! ?crumbs)/, [["slice", 35]], {count: true}),
  P(/^(bagel|baguette|roll|fralla|frukostbröd|bulle|bun)\b/, [["piece", 60]], {count: true}),
  P(/^(milk|mjölk|mellanmjölk|standardmjölk|lättmjölk)\b(?! (powder|shake|pudding|pulver|choklad))|^(oat|soy|almond|havre|soja|mandel)(drink|dryck| drink| dryck)|^(filmjölk|soured milk|fermented milk)/, [["glass (200 ml)", 206], ["dl", 103]], {g: 206, ml: 1.03}),
  P(/^(yoghurt|yogurt|youghurt|kvarg|quark|skyr|kefir|filmjölk)\b/, [["bowl (200 g)", 200], ["dl", 103]], {g: 200}),
  P(/juice|^(smoothie)/, [["glass (200 ml)", 208]], {g: 208, ml: 1.04}),
  P(/^(coffee|kaffe|tea|te)\b(?! (cream|whitener|grädde|substitute))/, [["cup (200 ml)", 200], ["mug (300 ml)", 300]], {g: 200, ml: 1}),
  P(/^(beer|öl|lager)\b/, [["bottle (330 ml)", 335], ["pint (500 ml)", 505]], {g: 335, ml: 1.01}),
  P(/^(wine|vin)\b/, [["glass (150 ml)", 150]], {g: 150, ml: 1}),
  P(/^(soda|soft drink|läsk|cola)\b/, [["can (330 ml)", 345]], {g: 345, ml: 1.04}),
  P(/(\boil\b|olja)/, [["tbsp", 14], ["tsp", 5]], {g: 14, ml: 0.92}),
  P(/^(butter|smör|margarine|margarin|bregott|matfett|spread)\b/, [["on a slice", 5], ["tbsp", 14]], {g: 5}),
  P(/^(honey|honung|syrup|sirap|jam|sylt|marmelad)\b/, [["tsp", 7], ["tbsp", 21]], {g: 7}),
  P(/^(sugar|socker)\b/, [["tsp", 4], ["tbsp", 12]], {g: 4}),
  P(/^(peanut butter|jordnötssmör|nut butter)/, [["tbsp", 16]], {g: 16}),
  P(/^(cheese|ost|cheddar|gouda|herrgård|präst|grevé)\b(?! (cake|kaka|sauce|sås))|hårdost/, [["slice", 10], ["matchbox-size piece", 20]], {count: true}),
  P(/^(cream|grädde|vispgrädde|matlagningsgrädde|crème fraiche|creme fraiche|gräddfil|sour cream)\b(?! (cheese|crackers))/, [["tbsp", 15], ["dl", 100]], {g: 15}),
  P(/^(oat|oats|havregryn|rolled oats|oatmeal)\b(?! (drink|biscuit|bran|dryck|kex))/, [["dl dry", 35]], {g: 40}),
  P(/^(porridge|gröt|havregrynsgröt|oatmeal porridge)/, [["bowl", 250]], {g: 250}),
  P(/^(muesli|müsli|granola|cereal|cornflakes|flingor)/, [["dl", 35], ["bowl", 45]], {g: 45}),
  P(/^(rice|ris)\b.*(boil|cook|kokt|kokat|steam)|^(cooked rice|boiled rice)/, [["portion", 180], ["cup", 160], ["dl", 70]], {g: 180}),
  P(/^(pasta|spaghetti|macaroni|makaroner|penne|fusilli)\b.*(boil|cook|kokt|kokta)/, [["portion", 200], ["cup", 140]], {g: 200}),
  P(/^(pasta|spaghetti|macaroni|makaroner|penne|fusilli|rice|ris)\b.*(dried|dry|uncooked|okokt|torr|rå)/, [["portion (dry)", 75]], {g: 75}),
  P(/^(potato|potatis)\b(?! (chips|crisps|salad|sallad|gratin|mos|mash|diced|frozen|canned))/, [["medium potato", 90], ["portion", 200]], {count: true}),
  P(/^(chicken breast|kycklingfilé|kycklingbröst)/, [["fillet", 130]], {g: 130}),
  P(/^(salmon|lax)\b(?! (cured|smoked|gravad|kallrökt|varmrökt|sauce))/, [["fillet", 125]], {g: 125}),
  P(/meatball|köttbull/, [["meatball", 18]], {count: true}),
  P(/^(sausage|korv|hot dog|varmkorv|prinskorv|chorizo|frankfurter)/, [["sausage", 60]], {count: true}),
  P(/^(almond|almonds|mandel|mandlar|nuts|nötter|cashew|walnut|valnöt|peanuts|jordnötter|hazelnut|hasselnöt|pistach)/, [["handful", 30]], {g: 30}),
  P(/^(chocolate|choklad)\b/, [["square", 5], ["row (4 squares)", 20]], {g: 20}),
  P(/^(protein powder|whey|proteinpulver|vassleprotein)/, [["scoop", 30]], {count: true}),
  P(/^(pizza)\b/, [["slice", 100], ["whole pizza", 400]], {count: true}),
  P(/^(salad|sallad|lettuce|isbergssallad|spenat|spinach|ruccola|rocket)\b/, [["handful", 25], ["side salad", 75]], {g: 50}),
  P(/^(broccoli|cauliflower|blomkål|green beans|haricots|peas|ärtor|corn|majs)\b/, [["portion", 80]], {g: 80}),
];

const nameKey = food => fold([food.en, food.name, food.base && food.base.name].filter(Boolean).join(" | "));
// The hint that fits a food, matched against each of its names separately so anchors work on both languages.
export function portionHint(food){
  const names = [food.en, food.name].filter(Boolean).map(fold);
  return PORTION_HINTS.find(h => names.some(n => h.re.test(n.trim()))) || null;
}

// Every way a food can be measured: its own portions (labels, USDA measures), household hints, then grams (and ml for drinks).
// Each option: {id, label, g} for weight-based foods (per 100 g), or {id, label, mult} for foods that only have per-serving values.
export function unitOptions(food){
  if (!food) return [];
  if (food.unit !== "100 g") return [{id: "serving", label: food.servingLabel || "serving", mult: 1}];
  const out = [], seen = new Set();
  const add = (label, g) => { const id = fold(label); if (g > 0 && !seen.has(id)) { seen.add(id); out.push({id, label, g}); } };
  (food.portions || []).filter(p => p && p.g > 0).slice(0, 6).forEach(p => add(p.label, p.g));
  const hint = portionHint(food);
  if (hint) hint.portions.forEach(([label, g]) => add(label, g));
  out.push({id: "g", label: "g", g: 1});
  const density = food.ml || (hint && hint.ml);
  if (density) out.push({id: "ml", label: "ml", g: density});
  return out;
}

// The amount a food opens with: one of its natural portion when it has one, otherwise a typical gram amount.
export function defaultQty(food){
  if (!food) return {amount: 1, unit: "serving"};
  if (food.qty) return normalizeQty(food, food.qty);
  if (food.unit !== "100 g") return {amount: 1, unit: "serving"};
  const opts = unitOptions(food), hint = portionHint(food);
  const own = (food.portions || []).find(p => p && p.g > 0);
  if (own) return {amount: 1, unit: fold(own.label)};
  if (hint && hint.count) return {amount: 1, unit: opts.find(o => o.g === hint.portions[0][1] && o.id !== "g").id};
  return {amount: hint && hint.g ? hint.g : 100, unit: "g"};
}

// Older entries stored {amount, factor, label}; turn them into {amount, unit}.
export function normalizeQty(food, q){
  if (!q) return defaultQty({...food, qty: undefined});
  if (q.unit) return {amount: +q.amount || 0, unit: q.unit};
  if (food.unit !== "100 g") return {amount: (+q.amount || 0) * (+q.factor || 1), unit: "serving"};
  if (q.label === "grams" || q.label === "g") return {amount: +q.amount || 0, unit: "g"};
  if (q.label === "100 g") return {amount: (+q.amount || 0) * 100, unit: "g"};
  const opt = unitOptions(food).find(o => o.id === fold(q.label));
  return opt ? {amount: +q.amount || 0, unit: opt.id} : {amount: Math.round((+q.amount || 0) * (+q.factor || 0) * 100 * 10) / 10, unit: "g"};
}

// How many "base units" of the food a quantity is: grams/100 for per-100 g foods, servings otherwise.
export function qtyMultiplier(food, q){
  const qty = normalizeQty(food, q), opt = unitOptions(food).find(o => o.id === qty.unit);
  if (!opt) return null;
  return opt.mult != null ? qty.amount * opt.mult : qty.amount * opt.g / 100;
}
export function qtyGrams(food, q){
  if (food.unit !== "100 g") return null;
  const m = qtyMultiplier(food, q); return m == null ? null : m * 100;
}
// "1 medium banana (120 g)", "150 g", "2 slices (70 g)", "1.5 servings".
export function qtyText(food, q){
  const qty = normalizeQty(food, q), opt = unitOptions(food).find(o => o.id === qty.unit);
  const a = toInput(qty.amount);
  if (!opt) return "";
  if (opt.id === "g") return `${a} g`;
  if (opt.id === "ml") return `${a} ml`;
  if (opt.mult != null) return qty.amount === 1 ? `1 ${opt.label}` : `${a} × ${opt.label}`;
  const grams = roundGrams(qty.amount * opt.g), withG = /\(\d/.test(opt.label) ? "" : ` · ${toInput(grams, 1)} g`;
  // Labels that already carry a count ("1 bar (60 g)") aren't prefixed with another one.
  if (/^\d/.test(opt.label)) return qty.amount === 1 ? opt.label + withG : `${a} × ${opt.label}${withG}`;
  return `${a} ${opt.label}${withG}`;
}

// Nutrients for an amount of a food. Calories are whole numbers, macros one decimal; micronutrients two.
export function nutrientsFor(food, q){
  const k = qtyMultiplier(food, q);
  if (k == null || !Number.isFinite(k)) return null;
  const m = food.m ? Object.fromEntries(Object.entries(food.m).filter(([, v]) => v != null && Number.isFinite(+v)).map(([key, v]) => [key, Math.round(v * k * 100) / 100])) : undefined;
  return {kcal: round0(food.kcal * k), p: round1(food.p * k), c: round1(food.c * k), f: round1(food.f * k), m};
}

export const totals = es => es.reduce((a, e) => ({kcal: a.kcal + (+e.kcal || 0), p: a.p + (+e.p || 0), c: a.c + (+e.c || 0), f: a.f + (+e.f || 0)}), {kcal: 0, p: 0, c: 0, f: 0});

// The food as remembered on an entry, so it can be re-measured or quick-added later.
export const baseOf = food => ({name: food.name, en: food.en || undefined, kcal: food.kcal, p: food.p, c: food.c, f: food.f, unit: food.unit || "serving",
  portions: food.portions || [], source: food.source || "", m: food.m, mEst: food.mEst, ml: food.ml, servingLabel: food.servingLabel});

export function makeEntry(food, q, meal, {id, now = Date.now()} = {}){
  const qty = normalizeQty(food, q), n = nutrientsFor(food, qty);
  if (!n) return null;
  const e = {id, name: food.name, amt: qtyText(food, qty), meal, kcal: n.kcal, p: n.p, c: n.c, f: n.f, base: {...baseOf(food), qty}, t: now};
  if (n.m) { e.m = n.m; if (food.mEst) e.mEst = true; }
  return e;
}
// Re-measure an existing entry, keeping its id, time and meal.
export function remeasure(entry, q){
  const food = entry.base, qty = normalizeQty(food, q), n = nutrientsFor(food, qty);
  if (!n) return entry;
  const out = {...entry, amt: qtyText(food, qty), kcal: n.kcal, p: n.p, c: n.c, f: n.f, base: {...food, qty}};
  if (n.m) out.m = n.m;
  if (out.name.includes(" · ")) out.name = out.name.replace(/\s*·.*$/, "");
  return out;
}
// Entries logged before amounts were stored separately have names like "Banana · 120 g".
export function entryTitle(e){
  if (e.amt != null) return {title: e.name, sub: e.amt};
  const i = e.name.indexOf(" · ");
  return i > 0 ? {title: e.name.slice(0, i), sub: e.name.slice(i + 3)} : {title: e.name, sub: ""};
}

// ---------- AI meal estimates ----------
// The model identifies components and estimates their edible weight and per-100 g nutrition; the app does the arithmetic.
// That keeps recognition, portion size, reference values and the calculation separate and lets a person change any grams later.
const num = {type: "number"};
export const MEAL_SCHEMA = {type: "object", additionalProperties: false,
  required: ["recognized", "observations", "meal_name", "components", "assumptions", "confidence", "needs_review"],
  properties: {
    recognized: {type: "boolean"},
    observations: {type: "string"},
    meal_name: {type: "string"},
    components: {type: "array", items: {type: "object", additionalProperties: false,
      required: ["name", "search_name", "visible", "basis", "household", "grams", "grams_low", "grams_high",
        "kcal_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g", "fiber_per_100g", "confidence"],
      properties: {
        name: {type: "string"}, search_name: {type: "string"}, visible: {type: "boolean"},
        basis: {type: "string", enum: ["label", "typical"]}, household: {type: "string"},
        grams: num, grams_low: num, grams_high: num,
        kcal_per_100g: num, protein_per_100g: num, carbs_per_100g: num, fat_per_100g: num, fiber_per_100g: num,
        confidence: {type: "string", enum: ["low", "medium", "high"]}}}},
    assumptions: {type: "array", items: {type: "string"}},
    confidence: {type: "string", enum: ["low", "medium", "high"]},
    needs_review: {type: "boolean"}}};

const SHARED_RULES =
  "\nMethod:" +
  "\n1. List the separate foods and drinks. Split a mixed dish into its main components (for example chicken, rice, sauce, cooking oil) only when that makes the estimate better; a sandwich, pizza slice, bowl of cereal with milk or a packaged product can stay one or two components. Never invent components you have no reason to believe are there." +
  "\n2. For each component estimate the edible weight in grams (no bones, peel or packaging; cooked weight for cooked food), with a realistic low-high range, and a household measure (\"1 medium\", \"2 slices\", \"1 cup\", \"1 tbsp\"). " +
  "\n3. Give nutrition per 100 g for the component as eaten (cooked rice, fried chicken), from standard food composition data. Macros per 100 g must be consistent with the calories (about 4 kcal/g protein and carbohydrate, 9 kcal/g fat, 7 kcal/g alcohol). If a nutrition label is legible, use its numbers and set basis to \"label\"; otherwise \"typical\"." +
  "\n4. Include cooking fat, butter, dressing or sauce as its own component when it is visible or the preparation clearly uses it (fried, sautéed, roasted, dressed); mark it visible=false when it is inferred, and say so in assumptions." +
  "\n5. search_name: a short generic English name as it would appear in a food composition table, food first then preparation, e.g. \"rice white boiled\", \"chicken breast fried\", \"potato boiled\", \"rapeseed oil\", \"bread wholegrain rye\"." +
  "\n6. Calibrate: a piece of fruit is roughly 50-120 kcal, a slice of bread 70-110, a bowl of cereal with milk 250-400, a typical sandwich 300-550, a full restaurant plate 700-1400. Do not default to a typical meal size; base every number on what is actually there." +
  "\n7. assumptions: up to 3 short sentences about what most affects the total (hidden oil, portion depth, sauce, a guess about what a food is). confidence per component and overall: high only when both the food and the amount are clear. Set needs_review to true when the amount or identity of a large component is uncertain." +
  "\n8. meal_name: a short natural name for what was eaten, in the same language the person used (English if no words were given).";

export function mealPrompt({mode = "photo", note = "", hint = "", text = ""} = {}){
  const clean = s => String(s || "").replace(/"/g, "'").slice(0, 1500).trim();
  const intro = mode === "photo"
    ? "You are an expert at estimating food portions and nutrition from photos. Look carefully at this specific photo. Use visible scale cues: plate or bowl diameter (a dinner plate is about 26 cm, a side plate 20 cm), cutlery, hands, cups, packaging and the depth and spread of the food. One photo cannot reveal hidden ingredients or exact depth, so give honest ranges instead of false precision. If the photo shows no food or drink, set recognized to false, components to an empty list and explain in observations."
    : "You are an expert at estimating food portions and nutrition from a person's description, in English or Swedish. Use the amounts they give exactly. Where they give none, assume a normal single portion as served in Sweden and state it in household. If the text doesn't describe any food or drink, set recognized to false and components to an empty list.";
  const context = [
    note ? `The person adds: "${clean(note)}". Treat stated weights, sizes and ingredients as facts.` : "",
    hint ? `The person corrected the previous estimate: "${clean(hint)}". Follow this correction.` : "",
    mode === "text" ? `What they ate: "${clean(text)}"` : "",
    "observations: one or two sentences on what you see and the size cues you used, before you estimate anything."
  ].filter(Boolean).join("\n");
  return intro + SHARED_RULES + "\n\n" + context;
}

const finite = v => typeof v === "number" ? Number.isFinite(v) : v !== "" && v != null && Number.isFinite(+v);
const clampConf = c => ["low", "medium", "high"].includes(c) ? c : "low";
// Check and tidy a model's answer before anything reaches the screen. Never fills in made-up values:
// a component without a usable weight or calories is left out and the estimate is marked for review.
export function normalizeMeal(raw){
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.components)) return {ok: false, kind: "malformed"};
  const parts = [];
  let dropped = 0;
  for (const c of raw.components.slice(0, 15)) {
    if (!c || typeof c !== "object") { dropped++; continue; }
    const name = String(c.name || "").trim().slice(0, 80);
    const grams = +c.grams;
    let kcal = finite(c.kcal_per_100g) ? +c.kcal_per_100g : NaN;
    const p = finite(c.protein_per_100g) ? +c.protein_per_100g : NaN, cb = finite(c.carbs_per_100g) ? +c.carbs_per_100g : NaN, f = finite(c.fat_per_100g) ? +c.fat_per_100g : NaN;
    const macrosOk = [p, cb, f].every(v => v >= 0 && v <= 100) && p + cb + f <= 105;
    if (!(kcal >= 0 && kcal <= 950) && macrosOk) kcal = 4 * p + 4 * cb + 9 * f;   // calories missing but macros usable
    if (!name || !(grams > 0 && grams <= 3000) || !(kcal >= 0 && kcal <= 950)) { dropped++; continue; }
    let low = +c.grams_low, high = +c.grams_high;
    if (!(low > 0 && low <= grams)) low = null;
    if (!(high >= grams && high <= 5000)) high = null;
    const atwater = macrosOk ? 4 * p + 4 * cb + 9 * f : null;
    parts.push({
      on: true, name, search: String(c.search_name || name).trim().slice(0, 80), visible: c.visible !== false,
      basis: c.basis === "label" ? "label" : "typical", household: String(c.household || "").trim().slice(0, 40),
      grams: roundGrams(grams), ai: roundGrams(grams), low: low && roundGrams(low), high: high && roundGrams(high),
      per: {kcal: round1(kcal), p: macrosOk ? round1(p) : 0, c: macrosOk ? round1(cb) : 0, f: macrosOk ? round1(f) : 0, fiber: c.fiber_per_100g >= 0 && c.fiber_per_100g <= 100 ? round1(c.fiber_per_100g) : 0},
      // Macros that don't add up to the calories (beyond alcohol, fibre and rounding) are worth a second look.
      check: !macrosOk || (atwater != null && kcal > 20 && Math.abs(atwater - kcal) / kcal > 0.3 && Math.abs(atwater - kcal) > 40),
      conf: clampConf(c.confidence), source: c.basis === "label" ? "Nutrition label" : "AI estimate"
    });
  }
  if (!parts.length) return {ok: false, kind: raw.recognized === false ? "unrecognized" : "empty", message: String(raw.observations || "").slice(0, 300)};
  const assumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : []).map(a => String(a).trim()).filter(Boolean).slice(0, 4);
  if (dropped) assumptions.push(`${dropped} ${dropped === 1 ? "item" : "items"} couldn't be estimated and ${dropped === 1 ? "was" : "were"} left out.`);
  const confidence = clampConf(raw.confidence);
  const name = String(raw.meal_name || "").trim().slice(0, 80) || parts.map(p => p.name).slice(0, 3).join(", ");
  return {ok: true, meal: {name, observations: String(raw.observations || "").trim().slice(0, 400), assumptions, confidence,
    needsReview: raw.needs_review === true || confidence === "low" || dropped > 0 || parts.some(p => p.check || (p.conf === "low" && p.grams * p.per.kcal / 100 > 150)),
    parts}};
}

export const partNutrients = part => {
  const k = (+part.grams || 0) / 100, m = part.m ? Object.fromEntries(Object.entries(part.m).map(([key, v]) => [key, Math.round(v * k * 100) / 100])) : undefined;
  return {kcal: part.per.kcal * k, p: part.per.p * k, c: part.per.c * k, f: part.per.f * k, fiber: (part.per.fiber || 0) * k, m};
};
// Totals of the included components, summed before rounding so the total matches the parts.
export function mealTotals(parts){
  const t = parts.filter(p => p.on).map(partNutrients).reduce((a, n) => ({kcal: a.kcal + n.kcal, p: a.p + n.p, c: a.c + n.c, f: a.f + n.f, fiber: a.fiber + n.fiber}), {kcal: 0, p: 0, c: 0, f: 0, fiber: 0});
  return {kcal: round0(t.kcal), p: round1(t.p), c: round1(t.c), f: round1(t.f), fiber: round1(t.fiber)};
}

// Swap the model's per-100 g values for a food database entry when one clearly matches.
// A match must contain every word of the component's search name and be within 25% of the model's calories,
// which rules out raw-versus-cooked mix-ups (raw rice is ~3x cooked rice) and unrelated foods with a shared word.
const PREP = /^(cooked|boiled|fried|grilled|baked|roasted|steamed|raw|fresh|sauteed|sautéed|pan|plain|homemade|w\/|with|and|in)$/;
export function groundPart(part, dbFoods){
  if (!dbFoods || !dbFoods.length || part.basis === "label") return part;
  const q = part.search || part.name;
  let cands = searchFoods(dbFoods, q, 12);
  if (!cands.length) { const core = words(q).filter(w => !PREP.test(w)).join(" "); if (core && core !== fold(q)) cands = searchFoods(dbFoods, core, 12); }
  const target = part.per.kcal, head = words(q).find(w => !PREP.test(w)) || "";
  let best = null, bestD = Infinity;
  for (const f of cands) {
    if (!(f.kcal >= 0)) continue;
    // Same food, not just a shared word: the name must start with the component's food word ("cream sauce" is not
    // "onion sauce with cream"), and the fat content must roughly agree.
    if (head && !fold(f.en).startsWith(head) && !fold(f.name).startsWith(head)) continue;
    if (Math.abs((f.f || 0) - part.per.f) > Math.max(3, part.per.f * 0.4)) continue;
    const d = target < 15 && f.kcal < 15 ? Math.abs(f.kcal - target) / 15 : f.kcal > 0 && target > 0 ? Math.abs(Math.log(f.kcal / target)) : Infinity;
    if (d < bestD) { bestD = d; best = f; }
  }
  if (!best || bestD > Math.log(1.25)) return part;
  return {...part, per: {kcal: best.kcal, p: best.p || 0, c: best.c || 0, f: best.f || 0, fiber: (best.m && best.m.fiber) || 0},
    m: best.m, basis: "database", source: `${best.source || "Database"}: ${best.en || best.name}`, refName: best.name};
}

// ---------- AI label reading ----------
export const LABEL_SCHEMA = {type: "object", additionalProperties: false,
  required: ["found", "name", "basis", "per", "serving_text", "serving_grams", "kcal", "protein_g", "carbs_g", "fat_g"],
  properties: {found: {type: "boolean"}, name: {type: "string"}, basis: {type: "string", enum: ["label", "estimate", "none"]},
    per: {type: "string", enum: ["100g", "100ml", "serving"]}, serving_text: {type: "string"}, serving_grams: num,
    kcal: num, protein_g: num, carbs_g: num, fat_g: num}};
export const LABEL_PROMPT =
  "This photo shows a packaged food: its nutrition panel, the front of the pack, or its barcode. Identify the product. " +
  "If a nutrition table is legible, copy its numbers exactly and set basis to \"label\". Prefer the per 100 g (or per 100 ml) column and set per accordingly; use per=\"serving\" only when no per-100 column is printed. " +
  "Also give the serving size text and its weight in grams (0 if not printed). If no table is legible but you clearly recognise the product, give typical values with basis \"estimate\". " +
  "If you can't identify it, set found to false and basis to \"none\" and use zeros. Never guess a number you can't read when basis is \"label\".";
// Turn a label reading into a food the app can measure. Returns null when the reading isn't usable.
export function foodFromLabel(r){
  if (!r || r.found !== true || r.basis === "none") return null;
  const vals = [r.kcal, r.protein_g, r.carbs_g, r.fat_g].map(Number);
  if (!(vals[0] >= 0 && vals[0] <= 950) || vals.some(v => !Number.isFinite(v) || v < 0)) return null;
  const name = String(r.name || "Packaged food").trim().slice(0, 80);
  const source = r.basis === "estimate" ? "AI estimate" : "Nutrition label";
  const sg = +r.serving_grams;
  if (r.per === "serving") {
    if (sg > 0) { const k = 100 / sg; return {name, kcal: round1(vals[0] * k), p: round1(vals[1] * k), c: round1(vals[2] * k), f: round1(vals[3] * k), unit: "100 g", portions: [{label: `serving (${roundGrams(sg)} g)`, g: sg}], source}; }
    return {name, kcal: round0(vals[0]), p: round1(vals[1]), c: round1(vals[2]), f: round1(vals[3]), unit: "serving", servingLabel: String(r.serving_text || "serving").slice(0, 30), source};
  }
  const portions = sg > 0 ? [{label: r.serving_text && /\d/.test(r.serving_text) ? String(r.serving_text).slice(0, 30) : `serving (${roundGrams(sg)} g)`, g: sg}] : [];
  return {name, kcal: round1(vals[0]), p: round1(vals[1]), c: round1(vals[2]), f: round1(vals[3]), unit: "100 g", portions, source, ml: r.per === "100ml" ? 1 : undefined};
}

// ---------- weight log ----------
// {date: {kg, u}}; a deleted day keeps {kg: null, u} so the deletion syncs.
export const weightList = w => Object.entries(w || {}).filter(([, v]) => v && v.kg > 0).map(([d, v]) => ({d, kg: v.kg})).sort((a, b) => a.d < b.d ? -1 : 1);
export const KG_PER_LB = 0.45359237;

// ---------- device sync ----------
export const SECTIONS = ["settings", "profile", "coach", "microRefs", "plan", "dayTargets"]; // each synced whole; the most recently changed copy wins
// a = this device, b = the repo copy. Entries merge one by one (newest edit wins), deletions win over older edits.
export function mergeLedger(a, b, now = Date.now()){
  const cutoff = now - 120 * 864e5, deleted = {};
  [a.deleted || {}, b.deleted || {}].forEach(d => Object.entries(d).forEach(([id, t]) => { if (t > cutoff && t > (deleted[id] || 0)) deleted[id] = t; }));
  const byId = new Map();
  [a.days || {}, b.days || {}].forEach(days => Object.entries(days).forEach(([day, list]) => (list || []).forEach(e => {
    if (!e || !e.id) return;
    const cur = byId.get(e.id);
    if (!cur || (e.u || e.t || 0) > (cur.e.u || cur.e.t || 0)) byId.set(e.id, {day, e});
  })));
  const days = {};
  byId.forEach(({day, e}) => { if ((deleted[e.id] || 0) >= (e.u || e.t || 0)) return; (days[day] ||= []).push(e); });
  Object.values(days).forEach(list => list.sort((x, y) => (x.t || 0) - (y.t || 0)));
  const weights = {};
  [a.weights || {}, b.weights || {}].forEach(w => Object.entries(w).forEach(([d, v]) => { if (v && (!weights[d] || (v.u || 0) > (weights[d].u || 0))) weights[d] = v; }));
  const out = {v: 1, days, deleted, weights, stamps: {}, barcodes: {...(b.barcodes || {}), ...(a.barcodes || {})}, reviews: {}, ingr: {...(b.ingr || {}), ...(a.ingr || {})}};
  SECTIONS.forEach(k => {
    const sa = (a.stamps || {})[k] || 0, sb = (b.stamps || {})[k] || 0, useB = sb >= sa;   // ties go to the repo so devices agree
    out[k] = (useB ? b[k] : a[k]) ?? null; if (Math.max(sa, sb)) out.stamps[k] = Math.max(sa, sb);
  });
  new Set([...Object.keys(a.reviews || {}), ...Object.keys(b.reviews || {})]).forEach(d => {
    const ra = (a.reviews || {})[d], rb = (b.reviews || {})[d];
    out.reviews[d] = !ra ? rb : !rb ? ra : (rb.at || 0) > (ra.at || 0) ? rb : ra;
  });
  return out;
}
