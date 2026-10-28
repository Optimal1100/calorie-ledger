// End-to-end checks of the real app in an iframe. Gemini is mocked at the network layer, so these never call an AI
// or need a real key. The page's own data for this origin is backed up first and restored afterwards.
import {test, eq, ok, near} from "./harness.js";

const frame = document.getElementById("app");
let W, D, mock = null, aiCalls = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, what = "condition"){
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
const $ = id => D.getElementById(id);
const click = el => { (typeof el === "string" ? $(el) : el).click(); };
const type = (el, v) => { el = typeof el === "string" ? $(el) : el; el.value = v; el.dispatchEvent(new W.Event("input", {bubbles: true})); };
const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const state = () => W.__ledger.state;
const dayKcal = () => (state().days[today()] || []).reduce((a, e) => a + e.kcal, 0);
const saved = () => JSON.parse(W.localStorage.getItem("calorie-ledger-v1"));

const backup = {};
for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("calorie-ledger")) backup[k] = localStorage.getItem(k); }
window.addEventListener("pagehide", restore);
function restore(){
  Object.keys(localStorage).filter(k => k.startsWith("calorie-ledger")).forEach(k => localStorage.removeItem(k));
  Object.entries(backup).forEach(([k, v]) => localStorage.setItem(k, v));
}
async function boot({fresh = true} = {}){
  if (fresh) {
    Object.keys(localStorage).filter(k => k.startsWith("calorie-ledger")).forEach(k => localStorage.removeItem(k));
    localStorage.setItem("calorie-ledger-keys", JSON.stringify({gemini: "test-key-not-real"}));
    localStorage.setItem("calorie-ledger-v1", JSON.stringify({coach: {auto: false}}));
  }
  frame.src = "../index.html?t=" + Date.now() + "#today";
  await new Promise(r => frame.onload = r);
  W = frame.contentWindow; D = W.document;
  // Answer Gemini calls from the current mock; everything else goes to the network as usual.
  const realFetch = W.fetch.bind(W);
  W.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      aiCalls++;
      const m = typeof mock === "function" ? await mock(JSON.parse(opts.body), opts) : mock;
      if (m && m.status) return new W.Response(JSON.stringify({error: {message: m.message || "mock error"}}), {status: m.status});
      return new W.Response(JSON.stringify({candidates: [{content: {parts: [{text: typeof m === "string" ? m : JSON.stringify(m)}]}, finishReason: "STOP"}]}), {status: 200});
    }
    return realFetch(url, opts);
  };
  await until(() => W.__ledger, 4000, "app start");
}
async function photo(){
  const c = D.createElement("canvas"); c.width = 64; c.height = 48; const x = c.getContext("2d"); x.fillStyle = "#c84"; x.fillRect(0, 0, 64, 48);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const dt = new W.DataTransfer(); dt.items.add(new W.File([blob], "meal.png", {type: "image/png"}));
  $("mealFile").files = dt.files; $("mealFile").dispatchEvent(new W.Event("change"));
}
const MEAL = {recognized: true, observations: "A dinner plate (about 26 cm) with grilled chicken, white rice and a little sauce.", meal_name: "Chicken with rice",
  components: [
    {name: "Grilled chicken breast", search_name: "chicken breast grilled", visible: true, basis: "typical", household: "1 fillet", grams: 140, grams_low: 110, grams_high: 170, kcal_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6, fiber_per_100g: 0, confidence: "medium"},
    {name: "White rice", search_name: "rice white boiled", visible: true, basis: "typical", household: "1 cup", grams: 180, grams_low: 150, grams_high: 220, kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3, fiber_per_100g: 0.4, confidence: "high"},
    {name: "Cooking oil", search_name: "rapeseed oil", visible: false, basis: "typical", household: "1 tsp", grams: 5, grams_low: 2, grams_high: 10, kcal_per_100g: 884, protein_per_100g: 0, carbs_per_100g: 0, fat_per_100g: 100, fiber_per_100g: 0, confidence: "low"}],
  assumptions: ["Oil used for grilling is assumed."], confidence: "medium", needs_review: false};

test("app starts on Today with an empty day", async () => {
  await boot();
  eq($("viewTitle").textContent, "Today"); eq($("sumBig").textContent.replace(/\D/g, ""), "2000");
  eq(D.querySelectorAll("#meals .section").length, 4);
});
test("search the food database, pick a food and add it in its natural unit", async () => {
  click(D.querySelector('.tabbar [data-tab="add"]'));
  ok($("sheet-add").classList.contains("on"), "add sheet open");
  type("q", "banan");
  const row = await until(() => [...D.querySelectorAll("#addList [data-food]")].find(r => /^Banan$/.test(r.querySelector(".title").textContent)), 6000, "banana in results");
  click(row);
  ok($("sheet-food").classList.contains("on"));
  eq($("fsUnit").selectedOptions[0].textContent.startsWith("medium banana"), true, "opens in bananas");
  eq($("fsAmt").value, "1");
  const kcal = +$("fsKcal").textContent.match(/\d+/)[0];
  click("fsAdd");
  await until(() => dayKcal() === kcal, 2000, "entry logged");
  ok(!$("sheet-food").classList.contains("on"), "sheet closed");
  eq(state().days[today()][0].amt, "1 medium banana · 120 g");
});
test("comma decimals work in the amount field and switching units keeps the quantity", async () => {
  const e = state().days[today()][0];
  click(D.querySelector(`[data-entry="${e.id}"]`));
  type("fsAmt", "1,5");
  eq($("fsAmt").getAttribute("aria-invalid"), "false");
  const before = $("fsKcal").textContent;
  $("fsUnit").value = "g"; $("fsUnit").dispatchEvent(new W.Event("change", {bubbles: true}));
  eq(parseFloat($("fsAmt").value), 180, "1.5 bananas = 180 g"); eq($("fsKcal").textContent.split(" ")[0], before.split(" ")[0], "same calories");
  type("fsAmt", "abc");
  eq($("fsAmt").getAttribute("aria-invalid"), "true"); ok($("fsSave").disabled, "can't save an invalid amount"); ok($("fsAmtErr").textContent);
  type("fsAmt", "200"); click("fsSave");
  await until(() => state().days[today()][0].amt === "200 g", 2000, "edit saved");
  eq(state().days[today()].length, 1, "edited in place, not duplicated");
  eq(saved().days[today()][0].amt, "200 g", "persisted");
});
test("editing a food updates the day total immediately", async () => {
  const e = state().days[today()][0];
  near(e.kcal, 188, 10);
  eq($("sumBig").textContent.replace(/\D/g, ""), String(2000 - e.kcal));
});
test("manual entry validates and logs exact values; long names don't break the layout", async () => {
  click(D.querySelector('[data-add="lunch"]'));
  eq($("addTitle").textContent, "Add to Lunch", "meal from the row");
  click(D.querySelector("#addList [data-manual]"));
  type("manKcal", "x"); click("manAdd");
  eq($("manKcal").getAttribute("aria-invalid"), "true"); ok($("manNameErr").textContent, "name required");
  const long = "Extraordinarily long homemade lasagne with spinach, ricotta, three cheeses and a béchamel that goes on and on";
  type("manName", long); type("manKcal", "1234,5"); type("manP", "40,2"); type("manServ", "2");
  click("manAdd");
  await until(() => state().days[today()].length === 2, 2000, "manual logged");
  const m = state().days[today()][1];
  eq(m.meal, "lunch"); eq(m.kcal, 2469); eq(m.p, 80.4);
  ok(D.documentElement.scrollWidth <= W.innerWidth + 1, "no horizontal scroll");
});
test("deleting an entry updates totals, and undo restores it", async () => {
  const before = dayKcal(), e = state().days[today()][1];
  click(D.querySelector(`[data-entry="${e.id}"]`)); click("fsDel");
  await until(() => dayKcal() === before - e.kcal, 2000, "deleted");
  click("toastUndo");
  await until(() => dayKcal() === before, 2000, "restored");
});
test("photo estimate: components, editable grams, totals, and the logged values match the review", async () => {
  mock = MEAL; aiCalls = 0;
  const before = dayKcal();
  await photo();
  await until(() => $("aiKcal"), 6000, "review shown");
  eq(aiCalls, 1);
  eq(D.querySelectorAll("#aiParts .part").length, 3);
  const shown = () => +$("aiKcal").textContent.replace(/\D/g, "");
  const first = shown(); ok(first > 450 && first < 600, `plausible total, got ${first}`);
  // Two-fold more chicken
  const g = D.querySelector('[data-g="0"]'); type(g, "280");
  const after = shown(); near(after - first, 225, 50, "140 g more chicken");
  // Leave out the oil
  click(D.querySelector('[data-tick="2"]')); ok(shown() < after);
  const final = shown();
  click("aiAdd");
  await until(() => dayKcal() === before + final, 3000, "logged");
  const e = state().days[today()].at(-1);
  eq(e.parts.length, 2, "only included parts"); eq(e.parts[0].grams, 280); eq(e.kcal, final, "stored = reviewed");
});
test("an AI meal can be reopened and adjusted later", async () => {
  const e = state().days[today()].at(-1), before = dayKcal();
  click(D.querySelector(`[data-entry="${e.id}"]`));
  await until(() => $("aiSave"), 2000, "edit sheet");
  click(D.querySelector('[data-scale="0.5"]'));
  const half = +$("aiKcal").textContent.replace(/\D/g, "");
  near(half, e.kcal / 2, 3);
  click("aiSave");
  await until(() => dayKcal() === before - e.kcal + half, 2000, "saved");
});
test("malformed AI output shows an error and logs nothing", async () => {
  mock = "{\"kcal\": 500}"; const n = state().days[today()].length;
  await photo();
  await until(() => $("aiRetry") && D.querySelector("#aiBody .notice.err"), 6000, "error state");
  ok(!$("aiAdd"), "no add button"); eq(state().days[today()].length, n);
  mock = "not json at all"; click("aiRetry");
  await until(() => D.querySelector("#aiBody .notice.err") && !D.querySelector("#aiBody .skel"), 6000, "error again");
  eq(state().days[today()].length, n);
  click(D.querySelector("#sheet-ai [data-close]"));
});
test("a photo with no food says so instead of guessing", async () => {
  mock = {recognized: false, observations: "The photo shows a keyboard.", meal_name: "", components: [], assumptions: [], confidence: "low", needs_review: true};
  await photo();
  const msg = await until(() => D.querySelector("#aiBody .notice.err"), 6000, "message");
  ok(/No food recognised/.test(msg.textContent) && /keyboard/.test(msg.textContent));
  click(D.querySelector("#sheet-ai [data-close]"));
});
test("API errors are recoverable and say what happened", async () => {
  mock = {status: 429, message: "quota"};
  await photo();
  const msg = await until(() => D.querySelector("#aiBody .notice.err"), 8000, "error");
  ok(/limit/i.test(msg.textContent), msg.textContent);
  click(D.querySelector("#sheet-ai [data-close]"));
});
test("closing the sheet while the AI is working discards the late answer", async () => {
  const n = state().days[today()].length;
  let release; mock = () => new Promise(r => { release = () => r(MEAL); });
  await photo();
  await until(() => release, 3000, "request sent");
  click(D.querySelector("#sheet-ai [data-close]"));
  release(); await sleep(300);
  ok(!$("sheet-ai").classList.contains("on"), "stays closed"); ok(!$("aiKcal"), "no stale review rendered");
  eq(state().days[today()].length, n);
});
test("weight: comma decimals save, invalid values are refused", async () => {
  click(D.querySelector('.tabbar [data-tab="trends"]'));
  click("logWeight");
  type("wVal", "abc"); click("wSave");
  ok($("wErr").textContent); ok(!state().weights[today()], "nothing saved");
  type("wVal", "72,5"); click("wSave");
  await until(() => state().weights[today()], 2000, "saved");
  eq(state().weights[today()].kg, 72.5); eq(+state().profile.weightKg, 72.5, "profile follows the log");
  ok(/72[.,]5/.test($("weightOut").textContent));
  click(D.querySelector(`[data-wedit="${today()}"]`));
  eq($("wVal").value.replace(",", "."), "72.5"); type("wVal", "72.4"); click("wSave");
  await until(() => state().weights[today()].kg === 72.4, 2000, "edited");
});
test("settings: targets validate and a comma weight saves", async () => {
  click("settingsBtn");
  type("tGoal", "90000"); D.getElementById("targetForm").requestSubmit();
  ok($("tGoalErr").textContent); eq(state().settings.goal, 2000);
  type("tGoal", "2 300"); D.getElementById("targetForm").requestSubmit();
  eq(state().settings.goal, 2300);
  type("pfWeight", "71,8"); D.getElementById("profileForm").requestSubmit();
  eq(+state().profile.weightKg, 71.8); eq(state().weights[today()].kg, 71.8, "weight log updated too");
});
test("everything survives a reload", async () => {
  const kcal = dayKcal(), n = state().days[today()].length;
  await boot({fresh: false});
  eq(dayKcal(), kcal); eq(state().days[today()].length, n); eq(state().settings.goal, 2300); eq(state().weights[today()].kg, 71.8);
  ok(D.querySelectorAll("#meals [data-entry]").length === n);
});
test("past days: logging goes to the day being viewed", async () => {
  click("prev");
  const y = W.__ledger.state.date; ok(y < today());
  click(D.querySelector('[data-add="snacks"]')); click(D.querySelector("#addList [data-manual]"));
  type("manName", "Apple"); type("manKcal", "80"); click("manAdd");
  await until(() => (state().days[y] || []).length === 1, 2000, "logged yesterday");
  eq($("viewTitle").textContent, "Yesterday");
  click("toToday"); eq($("viewTitle").textContent, "Today");
});
