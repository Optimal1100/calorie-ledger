import {test, eq, ok, near} from "./harness.js";
import {parseDecimal, readAmount, unitOptions, defaultQty, normalizeQty, qtyMultiplier, qtyText, nutrientsFor, makeEntry, remeasure, entryTitle, totals,
  normalizeMeal, mealTotals, partNutrients, groundPart, foodFromLabel, mergeLedger, searchFoods, fold, weightList, mealPrompt} from "../js/core.js";

// ---------- numbers ----------
test("decimal comma and point both parse", () => {
  eq(parseDecimal("72,5"), 72.5); eq(parseDecimal("72.5"), 72.5); eq(parseDecimal(" 72,50 "), 72.5);
  eq(parseDecimal(",5"), 0.5); eq(parseDecimal("80"), 80); eq(parseDecimal("1,5", ","), 1.5); eq(parseDecimal("1,5", "."), 1.5);
});
test("thousands separators", () => {
  eq(parseDecimal("1 250"), 1250); eq(parseDecimal("1 250,5"), 1250.5); eq(parseDecimal("1.250,5"), 1250.5); eq(parseDecimal("1,250.5"), 1250.5);
  eq(parseDecimal("1,250", "."), 1250, "en locale"); eq(parseDecimal("1,250", ","), 1.25, "sv locale"); eq(parseDecimal("2.000.000"), 2000000);
});
test("empty and invalid input are told apart", () => {
  eq(parseDecimal(""), null); eq(parseDecimal("   "), null); eq(parseDecimal(null), null);
  ok(Number.isNaN(parseDecimal("abc"))); ok(Number.isNaN(parseDecimal("7,2,5x"))); ok(Number.isNaN(parseDecimal("1..2"))); ok(Number.isNaN(parseDecimal("1,2,3"))); ok(Number.isNaN(parseDecimal("1.2,3.4"))); ok(Number.isNaN(parseDecimal("5 kg")));
});
test("readAmount validates without silently changing values", () => {
  eq(readAmount("72,5"), {value: 72.5}); eq(readAmount(""), {value: null}); eq(readAmount("", {required: true}), {error: "Required"});
  eq(readAmount("-3"), {error: "Can't be negative"}); eq(readAmount("0", {allowZero: false}), {error: "Must be more than 0"});
  eq(readAmount("x"), {error: "Enter a number"}); ok(readAmount("9000", {max: 8000}).error); eq(readAmount("1e3").error, "Enter a number");
  eq(readAmount("999999999"), {value: 999999999});
});

// ---------- portions and units ----------
const banana = {name: "Banan", en: "Banana", kcal: 94, p: 1.1, c: 20, f: 0.3, unit: "100 g", portions: [], source: "Livsmedelsverket"};
const rice = {name: "Ris vitt kokt", en: "Rice white long grain boiled", kcal: 130, p: 2.6, c: 28, f: 0.3, unit: "100 g", portions: []};
const milk = {name: "Mjölk fett 3%", en: "Milk 3% fat fortified", kcal: 60, p: 3.4, c: 4.8, f: 3, unit: "100 g", portions: []};
const tallow = {name: "Nöt talg", en: "Beef tallow", kcal: 884, p: 0, c: 0, f: 100, unit: "100 g", portions: []};
test("a banana opens as one banana, not 100 g", () => {
  const q = defaultQty(banana), opt = unitOptions(banana).find(o => o.id === q.unit);
  eq(q.amount, 1); eq(opt.label, "medium banana"); eq(opt.g, 120);
  eq(nutrientsFor(banana, q).kcal, 113);
  eq(qtyText(banana, q), "1 medium banana · 120 g");
});
test("cooked rice opens as a typical portion in grams terms", () => {
  const q = defaultQty(rice); eq(unitOptions(rice).find(o => o.id === q.unit).label === "portion" || q.unit === "g", true);
  ok(unitOptions(rice).some(o => o.id === "g"), "grams always available");
});
test("drinks offer ml with a density, not ml = g", () => {
  const ml = unitOptions(milk).find(o => o.id === "ml"); ok(ml, "ml option"); eq(ml.g, 1.03);
  eq(nutrientsFor(milk, {amount: 200, unit: "ml"}).kcal, Math.round(60 * 2.06));
  ok(!unitOptions(rice).some(o => o.id === "ml"), "no ml for rice");
});
test("foods without a hint fall back to 100 g in grams", () => {
  eq(defaultQty(tallow), {amount: 100, unit: "g"}); eq(unitOptions(tallow).map(o => o.id), ["g"]);
});
test("product serving from a label comes first", () => {
  const f = {...banana, name: "Proteinbar", en: "", portions: [{label: "1 bar (60 g)", g: 60}]};
  const q = defaultQty(f); eq(q.amount, 1); eq(unitOptions(f).find(o => o.id === q.unit).g, 60);
  eq(qtyText(f, q), "1 bar (60 g)"); eq(qtyText(f, {amount: 2, unit: q.unit}), "2 × 1 bar (60 g)");
});
test("legacy {amount, factor, label} quantities still measure the same", () => {
  eq(normalizeQty(banana, {amount: 100, factor: 0.01, label: "grams"}), {amount: 100, unit: "g"});
  eq(normalizeQty(banana, {amount: 2, factor: 1, label: "100 g"}), {amount: 200, unit: "g"});
  const serv = {name: "Latte", kcal: 150, p: 10, c: 15, f: 6, unit: "serving"};
  eq(normalizeQty(serv, {amount: 1, factor: 1, label: ""}), {amount: 1, unit: "serving"});
  eq(qtyMultiplier(serv, {amount: 1.5, unit: "serving"}), 1.5);
});
test("scaling is proportional and rounding is consistent", () => {
  const n = nutrientsFor(rice, {amount: 150, unit: "g"});
  eq(n, {kcal: 195, p: 3.9, c: 42, f: 0.5, m: undefined});
  eq(nutrientsFor(rice, {amount: 0.5, unit: "g"}).kcal, 1);
  eq(nutrientsFor(rice, {amount: 1, unit: "nonsense"}), null, "unknown unit is not guessed");
});
test("entries keep the amount apart from the name and re-measure cleanly", () => {
  const e = makeEntry(banana, {amount: 2, unit: defaultQty(banana).unit}, "breakfast", {id: "x", now: 1});
  eq(e.name, "Banan"); eq(e.kcal, 226); eq(entryTitle(e), {title: "Banan", sub: "2 medium banana · 240 g"});
  const e2 = remeasure(e, {amount: 150, unit: "g"});
  eq(e2.kcal, 141); eq(e2.id, "x"); eq(e2.meal, "breakfast"); eq(e2.base.qty, {amount: 150, unit: "g"});
  eq(entryTitle({name: "Banan · 100 g"}), {title: "Banan", sub: "100 g"}, "old entries split their name");
});
test("totals add up across entries", () => {
  eq(totals([{kcal: 100, p: 1.5, c: 2, f: 3}, {kcal: 50.4, p: "2", c: 0, f: null}, {}]), {kcal: 150.4, p: 3.5, c: 2, f: 3});
});

// ---------- AI meal results ----------
const comp = (o = {}) => ({name: "Chicken breast", search_name: "chicken breast fried", visible: true, basis: "typical", household: "1 fillet", grams: 150, grams_low: 120, grams_high: 180,
  kcal_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6, fiber_per_100g: 0, confidence: "medium", ...o});
const meal = (components, o = {}) => ({recognized: true, observations: "A plate with chicken and rice.", meal_name: "Chicken and rice", components, assumptions: ["Cooked in oil"], confidence: "medium", needs_review: false, ...o});
test("a valid answer becomes parts whose totals come from grams × per-100 g", () => {
  const r = normalizeMeal(meal([comp(), comp({name: "Rice", search_name: "rice white boiled", household: "1 cup", grams: 180, kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3})]));
  ok(r.ok); eq(r.meal.parts.length, 2);
  const t = mealTotals(r.meal.parts);
  eq(t.kcal, Math.round(150 * 1.65 + 180 * 1.3)); near(t.p, 46.5 + 4.86, 0.06); eq(r.meal.needsReview, false);
});
test("changing grams changes calories proportionally", () => {
  const r = normalizeMeal(meal([comp()])); const p = r.meal.parts[0];
  eq(Math.round(partNutrients(p).kcal), 248); p.grams = 300; eq(Math.round(partNutrients(p).kcal), 495);
  p.on = false; eq(mealTotals(r.meal.parts).kcal, 0);
});
test("no default calories: unusable components are dropped, not filled in", () => {
  const r = normalizeMeal(meal([comp({grams: 0}), comp({kcal_per_100g: "lots", protein_per_100g: null}), comp({name: ""})]));
  eq(r.ok, false); eq(r.kind, "empty");
  const r2 = normalizeMeal(meal([comp(), comp({grams: -5})]));
  ok(r2.ok); eq(r2.meal.parts.length, 1); ok(r2.meal.needsReview, "dropping something flags review"); ok(r2.meal.assumptions.some(a => /left out/.test(a)));
});
test("malformed and unrecognised answers are errors, never estimates", () => {
  eq(normalizeMeal(null).ok, false); eq(normalizeMeal("500").ok, false); eq(normalizeMeal({kcal: 500}).kind, "malformed");
  const r = normalizeMeal(meal([], {recognized: false, observations: "This is a photo of a dog."}));
  eq(r.kind, "unrecognized"); eq(r.message, "This is a photo of a dog.");
});
test("calories missing but macros present are derived; impossible values rejected", () => {
  const r = normalizeMeal(meal([comp({kcal_per_100g: null})])); ok(r.ok); near(r.meal.parts[0].per.kcal, 31 * 4 + 3.6 * 9, 0.1);
  eq(normalizeMeal(meal([comp({kcal_per_100g: 5000, protein_per_100g: 200})])).ok, false);
  eq(normalizeMeal(meal([comp({grams: 9000})])).ok, false, "9 kg of chicken isn't a portion");
});
test("macros that contradict calories are flagged for checking", () => {
  const r = normalizeMeal(meal([comp({kcal_per_100g: 400})])); ok(r.meal.parts[0].check); ok(r.meal.needsReview);
});
test("low confidence means needs review; confidence never defaults to high", () => {
  eq(normalizeMeal(meal([comp()], {confidence: "low"})).meal.needsReview, true);
  eq(normalizeMeal(meal([comp()], {confidence: undefined})).meal.confidence, "low");
});
test("the prompt asks for evidence, grams and per-100 g values and carries corrections", () => {
  const p = mealPrompt({mode: "photo", note: "", hint: "it's turkey, about 200 g"});
  ok(/grams/.test(p) && /per 100 g/.test(p) && /observations/.test(p)); ok(p.includes("it's turkey, about 200 g")); ok(!/500 kcal/.test(p));
  ok(mealPrompt({mode: "text", text: 'två "ägg"'}).includes("två 'ägg'"), "quotes are neutralised");
});

// ---------- grounding in the food database ----------
const db = [
  {name: "Ris vitt kokt", en: "Rice white long grain boiled", kcal: 125, p: 2.6, c: 27, f: 0.3, source: "Livsmedelsverket", m: {fiber: 0.4, iron: 0.2}},
  {name: "Ris vitt okokt", en: "Rice white long grain uncooked", kcal: 355, p: 7, c: 78, f: 0.6, source: "Livsmedelsverket", m: {}},
  {name: "Kycklingfilé stekt", en: "Chicken breast fried", kcal: 150, p: 30, c: 0, f: 3, source: "Livsmedelsverket", m: {}},
  {name: "Kycklingsallad", en: "Chicken salad w/ pineapple", kcal: 190, p: 9, c: 8, f: 14, source: "Livsmedelsverket", m: {}}
].map(f => ({...f, key: fold(f.name + " | " + f.en)}));
test("a clear database match replaces the model's per-100 g values", () => {
  const part = normalizeMeal(meal([comp({name: "Rice", search_name: "rice white boiled", kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3})])).meal.parts[0];
  const g = groundPart(part, db); eq(g.basis, "database"); eq(g.per.kcal, 125); eq(g.m.iron, 0.2); ok(/Livsmedelsverket/.test(g.source));
});
test("raw-versus-cooked and unrelated matches are rejected", () => {
  const part = normalizeMeal(meal([comp({name: "Rice", search_name: "rice white", kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3})])).meal.parts[0];
  eq(groundPart(part, db).per.kcal, 125, "picks cooked (closest), never raw 355");
  const odd = normalizeMeal(meal([comp({name: "Mystery", search_name: "dragonfruit", kcal_per_100g: 60, protein_per_100g: 1, carbs_per_100g: 13, fat_per_100g: 0.4})])).meal.parts[0];
  eq(groundPart(odd, db), odd, "no match keeps AI values");
  const sauce = normalizeMeal(meal([comp({name: "Sauce", search_name: "salad chicken", kcal_per_100g: 185, protein_per_100g: 9, carbs_per_100g: 8, fat_per_100g: 14})])).meal.parts[0];
  eq(groundPart(sauce, db).basis, "typical", "a name that merely contains the words doesn't match");
  const lean = normalizeMeal(meal([comp({search_name: "chicken breast fried", kcal_per_100g: 150, protein_per_100g: 22, carbs_per_100g: 0, fat_per_100g: 12})])).meal.parts[0];
  eq(groundPart(lean, db).basis, "typical", "fat content must agree");
  const label = {...part, basis: "label"}; eq(groundPart(label, db), label, "a read label wins over the database");
});

// ---------- labels ----------
test("a per-serving label with a known weight becomes per 100 g with that serving", () => {
  const f = foodFromLabel({found: true, name: "Protein bar", basis: "label", per: "serving", serving_text: "1 bar", serving_grams: 60, kcal: 210, protein_g: 20, carbs_g: 18, fat_g: 7});
  eq(f.unit, "100 g"); eq(f.kcal, 350); eq(f.portions, [{label: "serving (60 g)", g: 60}]);
  eq(nutrientsFor(f, defaultQty(f)).kcal, 210, "one serving is still 210 kcal");
  eq(foodFromLabel({found: false, basis: "none"}), null); eq(foodFromLabel({found: true, basis: "label", kcal: -1, protein_g: 0, carbs_g: 0, fat_g: 0}), null);
});

// ---------- search ----------
test("search matches Swedish and English names, best first", () => {
  eq(searchFoods(db, "ris kokt")[0].name, "Ris vitt kokt");
  eq(searchFoods(db, "chicken fried").map(f => f.name), ["Kycklingfilé stekt"]);
  eq(searchFoods(db, "kyckling").length, 2); eq(searchFoods(db, "   ").length, 0);
});

// ---------- sync and weights ----------
test("merge keeps the newest edit, honours deletions and merges weights", () => {
  const now = 2e12;
  const a = {days: {"2026-10-27": [{id: "1", kcal: 100, t: 1, u: 10}, {id: "2", kcal: 50, t: 2}]}, deleted: {}, weights: {"2026-10-27": {kg: 72.5, u: 5}}, stamps: {}};
  const b = {days: {"2026-10-27": [{id: "1", kcal: 120, t: 1, u: 20}, {id: "2", kcal: 50, t: 2}]}, deleted: {"2": now - 1000}, weights: {"2026-10-27": {kg: 72.4, u: 3}, "2026-10-28": {kg: null, u: 9}}, stamps: {}};
  const m = mergeLedger(a, b, now);
  eq(m.days["2026-10-27"].map(e => [e.id, e.kcal]), [["1", 120]]);
  eq(m.weights["2026-10-27"].kg, 72.5); eq(weightList(m.weights), [{d: "2026-10-27", kg: 72.5}]);
});
