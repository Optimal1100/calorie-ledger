import {parseDecimal, readAmount, toInput, round1, roundGrams, fold, searchFoods, unitOptions, defaultQty, normalizeQty, qtyMultiplier, qtyGrams,
  nutrientsFor, totals, makeEntry, remeasure, entryTitle, MEAL_SCHEMA, mealPrompt, normalizeMeal, partNutrients, mealTotals, groundPart,
  LABEL_SCHEMA, LABEL_PROMPT, foodFromLabel, weightList, KG_PER_LB, SECTIONS, mergeLedger} from "./core.js";
import {aiJSON as rawAI, aiErrorCopy, geminiCall, FAST_MODELS, setFastest} from "./ai.js";

// ---------- constants ----------
const MEALS = [["breakfast","Breakfast"],["lunch","Lunch"],["dinner","Dinner"],["snacks","Snacks"]];
const DEFAULTS = {goal:2000, p:130, c:225, f:65};
// Micronutrients tracked per entry: [key, label, unit, daily reference (FDA Daily Values for adults), kind, AI field name]
const MICROS = [
  ["fiber","Fibre","g",28,"min","fiber_g"], ["potassium","Potassium","mg",4700,"min","potassium_mg"], ["calcium","Calcium","mg",1300,"min","calcium_mg"],
  ["iron","Iron","mg",18,"min","iron_mg"], ["magnesium","Magnesium","mg",420,"min","magnesium_mg"], ["zinc","Zinc","mg",11,"min","zinc_mg"],
  ["vitc","Vitamin C","mg",90,"min","vitamin_c_mg"], ["vitd","Vitamin D","µg",20,"min","vitamin_d_mcg"], ["b12","Vitamin B12","µg",2.4,"min","vitamin_b12_mcg"],
  ["vita","Vitamin A","µg",900,"min","vitamin_a_mcg_rae"], ["folate","Folate","µg",400,"min","folate_mcg_dfe"], ["omega3","Omega-3","g",1.6,"min","omega3_g"],
  ["sodium","Sodium","mg",2300,"max","sodium_mg"], ["satfat","Saturated fat","g",20,"max","saturated_fat_g"], ["sugar","Sugars","g",null,"info","sugars_g"]
].map(([key,label,unit,ref,kind,ai]) => ({key,label,unit,ref,kind,ai}));
const MICRO_PROPS = Object.fromEntries(MICROS.map(m => [m.ai, {type:"number"}]));
const MICRO_REQ = MICROS.map(m => m.ai);
const LS_KEY = "calorie-ledger-v1", KEYS_KEY = "calorie-ledger-keys", DIAG_KEY = "calorie-ledger-diag";
const OFF = "https://world.openfoodfacts.org";
const CHEV = `<svg class="chev" viewBox="0 0 8 13"><path d="M1.5 1.5l5 5-5 5"/></svg>`;
const PLUS = `<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg>`;

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2,"0");
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y,m-1,d); };
const shift = (k,n) => { const d = parseKey(k); d.setDate(d.getDate()+n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const fmt = n => Math.round(+n || 0).toLocaleString();
const g = n => (Math.round((+n || 0)*10)/10).toLocaleString();
const r1 = round1;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const working = t => `<div class="working"><span class="spin"></span><span>${esc(t)} <span class="ai-note"></span></span></div>`;
const titleCase = s => s.toLowerCase().replace(/(^|[\s,(\/-])([a-z])/g, (m,a,b) => a + b.toUpperCase());
const mealLabel = k => (MEALS.find(m => m[0] === k) || MEALS[3])[1];
const daysBetween = (a, b) => Math.round((parseKey(a) - parseKey(b)) / 864e5);
function dayName(k){
  const diff = daysBetween(todayKey(), k);
  return diff === 0 ? "today" : diff === 1 ? "yesterday" : parseKey(k).toLocaleDateString(undefined,{weekday:"long", month:"short", day:"numeric"});
}
function dayTitle(k){
  const diff = daysBetween(todayKey(), k);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : parseKey(k).toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric"});
}
function ago(ts){
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48*60 ? `${Math.round(m/60)} h ago` : `${Math.round(m/1440)} days ago`;
}
const clock = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString(undefined, {hour:"numeric", minute:"2-digit"}); };
// Read a number field and show its error under it. Returns {value} or {error}.
function readField(id, opts){
  const r = readAmount($(id).value, opts), err = $(id + "Err");
  $(id).setAttribute("aria-invalid", r.error ? "true" : "false");
  if (err) err.textContent = r.error || "";
  return r;
}
const clearErr = id => { $(id).removeAttribute("aria-invalid"); if ($(id + "Err")) $(id + "Err").textContent = ""; };

// ---------- storage (this device) ----------
const state = { settings:{...DEFAULTS}, days:{}, barcodes:{}, coach:{focus:"overall energy and health", about:""}, reviews:{},
  profile:{units:"metric", sex:"", age:"", weightKg:"", heightCm:"", activity:"moderate", notes:""}, microRefs:null, plan:null,
  oura:{fetched:0, generated:"", days:{}}, dayTargets:{}, deleted:{}, stamps:{}, ingr:{}, weights:{}, date:todayKey(), meal:"breakfast" };
let keys = {gemini:"", anthropic:"", usda:"", ghRepo:"", ghToken:""};
const hasAI = () => !!(keys.gemini || keys.anthropic);
try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) { const o = JSON.parse(raw); state.settings = {...DEFAULTS, ...(o.settings||{})}; state.days = o.days || {}; state.barcodes = o.barcodes || {}; state.coach = {...state.coach, ...(o.coach||{})}; state.reviews = o.reviews || {};
    state.profile = {...state.profile, ...(o.profile||{})}; state.microRefs = o.microRefs || null; state.plan = o.plan || null;
    if (o.oura && o.oura.days) state.oura = o.oura; state.dayTargets = o.dayTargets || {}; state.deleted = o.deleted || {}; state.stamps = o.stamps || {}; state.ingr = o.ingr || {}; state.weights = o.weights || {}; }
  const k = localStorage.getItem(KEYS_KEY); if (k) keys = {...keys, ...JSON.parse(k)};
} catch {}
// A body weight typed in Settings before the weight log existed becomes its first entry.
if (+state.profile.weightKg > 0 && !weightList(state.weights).length) state.weights[todayKey()] = {kg: r1(+state.profile.weightKg), u: 1};
function saveLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify({settings:state.settings, days:state.days, barcodes:state.barcodes, coach:state.coach, reviews:state.reviews, profile:state.profile, microRefs:state.microRefs, plan:state.plan, oura:state.oura, dayTargets:state.dayTargets, deleted:state.deleted, stamps:state.stamps, ingr:state.ingr, weights:state.weights})); }
  catch { toast("Couldn't save. Your device storage may be full."); }
}
function persist(){ trackChanges(); saveLocal(); scheduleSync(); try { scheduleReview(); } catch {} }

// Diagnostics: the outcome of recent AI requests (model, time, error kind). No prompts, photos or keys.
let diag = []; try { diag = JSON.parse(localStorage.getItem(DIAG_KEY) || "[]"); } catch {}
function logDiag(x){
  diag = [{at: Date.now(), ...x}, ...diag].slice(0, 25);
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch {}
  if (!$("diagBox").hidden) renderDiag();
}
const aiNote = t => document.querySelectorAll(".ai-note").forEach(el => { el.textContent = t; });
const aiJSON = (file, prompt, schema, signal, task = "fast") => rawAI(file, prompt, schema, {signal, task, keys, note: aiNote, log: logDiag});

// ---------- device sync: every device merges its log with ledger.json in the private repo ----------
const SYNC_FILE = "ledger.json";
let syncBase = null, syncBusy = false, syncAgain = false, syncBlocked = false, syncErr = "", syncTimer = null, lastSync = 0, remoteLedger = {sha:null, etag:"", data:null};
const entryJSON = e => JSON.stringify({...e, u:undefined});
// Work out what changed since the last save: stamp changed sections, stamp edited entries, and record deletions.
function trackChanges(){
  const now = Date.now(), sec = {}, entries = new Map();
  SECTIONS.forEach(k => { sec[k] = JSON.stringify(state[k] ?? null); if (syncBase && syncBase.sec[k] !== sec[k]) state.stamps[k] = now; });
  Object.values(state.days).forEach(list => list.forEach(e => {
    const j = entryJSON(e); entries.set(e.id, j);
    if (!syncBase) return;
    const old = syncBase.entries.get(e.id);
    if (old === undefined ? state.deleted[e.id] : old !== j) e.u = now;   // restored after a delete, or edited
  }));
  if (syncBase) syncBase.entries.forEach((_, id) => { if (!entries.has(id)) state.deleted[id] = now; });
  syncBase = {sec, entries};
}
function setSyncBase(){ syncBase = null; trackChanges(); }
// Data from before syncing existed has no change times. Give anything that isn't a factory default a minimal one.
{
  const fresh = {settings:{...DEFAULTS}, profile:{units:"metric", sex:"", age:"", weightKg:"", heightCm:"", activity:"moderate", notes:""}, coach:{focus:"overall energy and health", about:""}, microRefs:null, plan:null, dayTargets:{}};
  SECTIONS.forEach(k => { if (!state.stamps[k] && JSON.stringify(state[k] ?? null) !== JSON.stringify(fresh[k])) state.stamps[k] = 1; });
}
setSyncBase();
const ledgerSnapshot = () => ({v:1, days:state.days, deleted:state.deleted, stamps:state.stamps, barcodes:state.barcodes, reviews:state.reviews, ingr:state.ingr, weights:state.weights,
  ...Object.fromEntries(SECTIONS.map(k => [k, state[k] ?? null]))});
const stable = v => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
function applyLedger(m){
  state.days = m.days; state.deleted = m.deleted; state.stamps = m.stamps; state.barcodes = m.barcodes; state.reviews = m.reviews; state.ingr = m.ingr || {}; state.weights = m.weights || {};
  state.settings = {...DEFAULTS, ...(m.settings || {})}; state.profile = {...state.profile, ...(m.profile || {})}; state.coach = {...state.coach, ...(m.coach || {})};
  state.microRefs = m.microRefs || null; state.plan = m.plan || null; state.dayTargets = m.dayTargets || {};
  setSyncBase(); saveLocal();
  fillTargets(); fillProfile(); render(); renderPlan();
}
const b64encode = str => { const bytes = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));
const ghHeaders = extra => ({"Authorization": `Bearer ${keys.ghToken}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...extra});
function scheduleSync(delay = 3000){
  if (!keys.ghRepo || !keys.ghToken) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => syncLedger(), delay);
}
async function syncLedger(manual){
  if (!keys.ghRepo || !keys.ghToken) return;
  if (syncBlocked && !manual) return;   // a read-only token can't sync; wait for a new one
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true; renderSync();
  const url = `https://api.github.com/repos/${keys.ghRepo}/contents/${SYNC_FILE}`;
  try {
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const res = await fetch(url, {cache: "no-store", headers: ghHeaders(remoteLedger.etag && remoteLedger.data ? {"If-None-Match": remoteLedger.etag} : {})});
      if (res.status === 401) throw "GitHub rejected the token.";
      if (res.status === 404) remoteLedger = {sha:null, etag:"", data:null};
      else if (res.ok) {
        const meta = await res.json();
        let text = meta.content ? b64decode(meta.content) : null;
        if (text == null) {   // files over 1 MB come back without content; fetch the raw file
          const raw = await fetch(url, {cache: "no-store", headers: ghHeaders({"Accept": "application/vnd.github.raw+json"})});
          if (!raw.ok) throw "Couldn't download the synced log from GitHub.";
          text = await raw.text();
        }
        remoteLedger = {sha: meta.sha, etag: res.headers.get("etag") || "", data: JSON.parse(text)};
      } else if (res.status !== 304) throw res.status === 403 ? "That token can't read this repo." : "GitHub had a problem. Will retry.";

      const merged = remoteLedger.data ? mergeLedger(ledgerSnapshot(), remoteLedger.data) : ledgerSnapshot();
      const mergedJ = stable(merged);
      if (!remoteLedger.data || mergedJ !== stable(remoteLedger.data)) {
        const put = await fetch(url, {method: "PUT", headers: ghHeaders({"Content-Type": "application/json"}),
          body: JSON.stringify({message: `Ledger sync from ${/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Mac/.test(navigator.userAgent) ? "Mac" : "browser"}`,
            content: b64encode(JSON.stringify(merged)), ...(remoteLedger.sha ? {sha: remoteLedger.sha} : {})})});
        if (put.status === 409 || put.status === 422) { remoteLedger.etag = ""; continue; }   // the other device saved first: fetch, merge and try again
        if (put.status === 403 || put.status === 404) { syncBlocked = true; throw "readonly"; }
        if (!put.ok) throw "GitHub had a problem saving. Will retry.";
        const pj = await put.json();
        remoteLedger = {sha: pj.content && pj.content.sha, etag: "", data: merged};
      }
      // Anything changed here while we were talking to GitHub is merged in again before applying.
      const now = mergeLedger(ledgerSnapshot(), merged);
      if (stable(now) !== stable(ledgerSnapshot())) applyLedger(now);
      if (stable(now) !== mergedJ) syncAgain = true;
      done = true;
    }
    if (!done) throw "Both devices kept saving at once. Will retry.";
    lastSync = Date.now(); syncErr = ""; syncBlocked = false;
    if (manual) toast("Devices synced");
  } catch (e) {
    syncErr = e === "readonly" ? "This token is read-only, so your log can't sync between devices. Use a token with Contents: Read and write."
      : typeof e === "string" ? e : "Couldn't reach GitHub. Changes are saved here and will sync when you're online.";
  } finally {
    syncBusy = false; renderSync();
    if (syncAgain) { syncAgain = false; scheduleSync(1500); }
  }
}
function renderSync(){
  const el = $("syncMsg"); if (!el) return;
  const on = !!(keys.ghRepo && keys.ghToken);
  el.className = "msg " + (syncErr ? "err" : "");
  el.textContent = !on ? "" : syncErr ? syncErr : syncBusy && !lastSync ? "Syncing your log…" : lastSync ? `Log synced ${ago(lastSync)}.` : "";
}
setInterval(() => { if (document.visibilityState === "visible") syncLedger(); renderSync(); }, 120000);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- derived ----------
const entriesFor = k => state.days[k] || [];
// A day's targets: the usual ones, unless an Oura-based adjustment was applied for that day.
const targetsFor = k => state.dayTargets[k] || state.settings;
// The food behind an entry, for re-measuring and quick-adding. Very old entries without one count as a single serving.
const foodOf = e => e.base ? {...e.base, ...(e.parts && !e.base.parts ? {parts: e.parts} : {})} : {name: entryTitle(e).title, kcal: +e.kcal || 0, p: +e.p || 0, c: +e.c || 0, f: +e.f || 0, unit: "serving", source: ""};
// Foods logged recently, most often first, each with the amount used last time.
function recents(limit = 15){
  const map = new Map(), today = todayKey();
  for (let i = 0; i < 45; i++) for (const e of entriesFor(shift(today, -i))) {
    const food = foodOf(e), key = fold(food.name) + "|" + (food.unit || "");
    const cur = map.get(key);
    if (!cur) map.set(key, {food: {...food, qty: food.qty || (e.parts ? {amount: 1, unit: "serving"} : undefined)}, n: 1, last: i, parts: e.parts});
    else cur.n++;
  }
  return [...map.values()].sort((a, b) => (b.n - b.last / 15) - (a.n - a.last / 15)).slice(0, limit);
}
function defaultMeal(){
  const h = new Date().getHours() + new Date().getMinutes()/60;
  return h < 10.5 ? "breakfast" : h < 15 ? "lunch" : h >= 17 && h < 21.5 ? "dinner" : "snacks";
}

// ---------- Oura ----------
const ouraOn = () => !!(keys.ghRepo && keys.ghToken);
let ouraBusy = false, ouraErr = "", ouraKicked = 0, ouraKickNote = "";
// Ask the cloud job in the repo to fetch from Oura right now, then pick up its result over the next few minutes.
async function kickOura(manual){
  if (!ouraOn() || Date.now() - ouraKicked < (manual ? 60e3 : 15 * 60e3)) return;
  ouraKicked = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${keys.ghRepo}/actions/workflows/oura.yml/dispatches`,
      {method: "POST", headers: ghHeaders({"Content-Type": "application/json"}), body: JSON.stringify({ref: "main"})});
    if (r.status === 204) { ouraKickNote = ""; [45, 80, 130, 200].forEach(sec => setTimeout(() => syncOura(), sec * 1000)); return; }
    ouraKicked = 0;
    ouraKickNote = r.status === 404 ? "" : "Give the token Actions: Read and write to refresh Oura when the app opens. Until then it updates hourly.";
  } catch { ouraKicked = 0; }
  renderOuraSettings();
}
const ouraStale = () => { const gen = Date.parse(state.oura.generated); return !gen || Date.now() - gen > 30 * 60e3; };
async function syncOura(manual){
  if (!ouraOn() || ouraBusy) return;
  ouraBusy = true; ouraErr = ""; renderOuraSettings();
  try {
    const res = await fetch(`https://api.github.com/repos/${keys.ghRepo}/contents/oura.json`, {
      headers: {"Authorization": `Bearer ${keys.ghToken}`, "Accept": "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28"}, cache: "no-store"});
    if (res.status === 401) throw "GitHub rejected the token. Create a new one and paste it here.";
    if (res.status === 403) throw "That token can't read this repo. It needs Contents access.";
    if (res.status === 404) throw "Couldn't find oura.json in that repo. Check the repo name and token, and that the Oura job has run once.";
    if (!res.ok) throw "GitHub had a problem. Try again in a minute.";
    const data = await res.json();
    if (!data || !Array.isArray(data.days)) throw "The file in that repo isn't an Oura summary.";
    state.oura = {fetched: Date.now(), generated: data.generated || "", days: Object.fromEntries(data.days.filter(d => d && d.date).map(d => [d.date, d]))};
    persist();
    if (manual) toast(`Oura updated: ${data.days.length} days`);
  } catch (e) {
    ouraErr = typeof e === "string" ? e : "Couldn't reach GitHub. Check your connection.";
  } finally { ouraBusy = false; render(); renderOuraSettings(); }
}
function renderOuraSettings(){
  if (document.activeElement !== $("ghRepo")) $("ghRepo").value = keys.ghRepo;
  if (document.activeElement !== $("ghToken")) $("ghToken").value = keys.ghToken;
  $("ouraConnect").textContent = ouraBusy || syncBusy ? "Syncing…" : ouraOn() ? "Sync now" : "Connect";
  $("ouraConnect").disabled = ouraBusy;
  $("ouraDisconnect").hidden = !ouraOn();
  const n = Object.keys(state.oura.days).length, gen = Date.parse(state.oura.generated);
  $("ouraMsg").className = "msg " + (ouraErr ? "err" : "");
  $("ouraMsg").textContent = ouraErr || (n ? `${n} days of Oura data, updated ${gen ? ago(gen) : "at an unknown time"}.${ouraKickNote ? " " + ouraKickNote : ""}` : ouraOn() ? "" : "Not connected.");
}
// Usual active burn: the median of the previous 14 days that have activity data.
function usualActive(k){
  const vals = [];
  for (let i = 1; i <= 14; i++) { const d = state.oura.days[shift(k, -i)]; if (d && d.active_kcal > 0 && d.steps > 0) vals.push(d.active_kcal); }
  if (vals.length < 4) return null;
  vals.sort((a,b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}
// Rule-based suggestion for a day from Oura activity and recovery. Returns null when there's no Oura data for it.
function ouraSuggestion(k){
  const o = state.oura.days[k]; if (!o) return null;
  const base = state.settings, why = [];
  let dk = 0, dp = 0, dc = 0, df = 0;
  const usual = usualActive(k);
  if (o.active_kcal > 0 && usual != null && o.active_kcal - usual >= 150) {
    const extra = o.active_kcal - usual, add = Math.min(600, Math.round(extra * 0.8 / 50) * 50);
    dk += add; dc += add * 0.65 / 4; dp += add * 0.15 / 4; df += add * 0.20 / 9;
    why.push(`You've burned ${fmt(o.active_kcal)} active kcal${o.workouts ? ` (${o.workouts})` : ""}, about ${fmt(extra)} more than usual. Most of the extra goes to carbs to refuel.`);
  }
  const y = state.oura.days[shift(k, -1)];
  if (o.readiness_score != null && o.readiness_score < 65) {
    dk += 100; dp += 10; dc += 15;
    why.push(`Readiness is ${fmt(o.readiness_score)}${y && usual != null && y.active_kcal - usual >= 300 ? " after a heavy day" : ""}. A little extra protein and carbs supports recovery.`);
  }
  if ((o.total_sleep_h != null && o.total_sleep_h < 6) || (o.sleep_score != null && o.sleep_score < 60)) {
    dp += 15; dc -= 15;
    why.push(`Short sleep (${o.total_sleep_h != null ? g(o.total_sleep_h) + " h" : "score " + fmt(o.sleep_score)}) raises hunger. Swapping some carbs for protein keeps you fuller.`);
  }
  if (!why.length) return {none:true};
  return {goal: Math.round((base.goal + dk) / 10) * 10, p: Math.round(base.p + dp), c: Math.max(0, Math.round(base.c + dc)), f: Math.round(base.f + df), dk: Math.round(dk), why};
}
function ouraText(k){
  const o = state.oura.days[k]; if (!o) return "";
  const bits = [];
  const add = (v, f) => { if (v != null && v !== "") bits.push(f(v)); };
  add(o.readiness_score, v => `readiness score ${v}`); add(o.sleep_score, v => `sleep score ${v}`);
  add(o.total_sleep_h, v => `slept ${v} h${o.deep_h != null ? ` (deep ${o.deep_h} h, REM ${o.rem_h ?? "?"} h)` : ""}`);
  add(o.avg_hrv_ms, v => `overnight HRV ${v} ms`); add(o.lowest_hr, v => `lowest heart rate ${v} bpm`); add(o.temp_deviation_c, v => `body temperature deviation ${v} C`);
  add(o.steps, v => `${v} steps`); add(o.active_kcal, v => `active burn ${v} kcal`); add(o.total_kcal, v => `total burn ${v} kcal`);
  if ((o.workout_list || []).length) bits.push(`workouts: ${o.workout_list.map(w => `${prettyActivity(w.activity)} ${clock(w.start)}-${clock(w.end)}${w.kcal != null ? `, ${w.kcal} kcal` : ""}${w.intensity ? `, ${w.intensity} intensity` : ""}`).join("; ")}`);
  else add(o.workouts, v => `workouts: ${v}`); add(o.stress_day_summary, v => `daytime stress: ${v}`);
  const usual = usualActive(k), avgOf = key => { const vs = []; for (let i = 1; i <= 14; i++) { const d = state.oura.days[shift(k, -i)]; if (d && d[key] != null) vs.push(d[key]); } return vs.length >= 4 ? Math.round(vs.reduce((a,b) => a + b, 0) / vs.length * 10) / 10 : null; };
  const norms = [["usual active burn", usual, "kcal"], ["average sleep", avgOf("total_sleep_h"), "h"], ["average readiness", avgOf("readiness_score"), ""], ["average HRV", avgOf("avg_hrv_ms"), "ms"]].filter(x => x[1] != null).map(x => `${x[0]} ${x[1]} ${x[2]}`.trim());
  return bits.join(", ") + (norms.length ? `. Their recent norms: ${norms.join(", ")}` : "");
}
// Average measured daily burn over the last 14 complete days, when Oura has enough of them.
function ouraBurn(){
  const today = todayKey(), vals = [];
  for (let i = 1; i <= 14; i++) { const d = state.oura.days[shift(today, -i)]; if (d && d.total_kcal > 0 && d.steps > 0) vals.push(d.total_kcal); }
  return vals.length >= 5 ? Math.round(vals.reduce((a,b) => a + b, 0) / vals.length) : null;
}

// ---------- personal targets ----------
// Daily reference intakes by sex and age (US/Canada DRIs). Without a sex set, the generic label Daily Values apply.
function driRefs(){
  const base = Object.fromEntries(MICROS.map(m => [m.key, m.ref]));
  const p = state.profile, goal = state.settings.goal;
  base.satfat = Math.round(goal * 0.10 / 9);
  if (!p.sex) return base;
  const f = p.sex === "female", age = +p.age || 30;
  return {...base,
    fiber: Math.round(goal / 1000 * 14),
    potassium: f ? 2600 : 3400,
    calcium: age < 19 ? 1300 : (f && age > 50) || age > 70 ? 1200 : 1000,
    iron: age < 19 ? (f ? 15 : 11) : f && age <= 50 ? 18 : 8,
    magnesium: f ? (age <= 30 ? 310 : 320) : (age <= 30 ? 400 : 420),
    zinc: f ? 8 : 11, vitc: f ? 75 : 90, vitd: age > 70 ? 20 : 15, b12: 2.4, vita: f ? 700 : 900, folate: 400, omega3: f ? 1.1 : 1.6, sodium: 2300};
}
const microRefs = () => ({...driRefs(), ...(state.microRefs || {})});
const ACTIVITY = {sedentary:[1.2,"mostly sitting, little exercise"], light:[1.375,"lightly active, exercise 1-2 days a week"], moderate:[1.55,"moderately active, exercise 3-5 days a week"],
  very:[1.725,"very active, hard exercise 6-7 days a week"], athlete:[1.9,"athlete, training twice a day or a physical job"]};
function profileText(){
  const p = state.profile, bits = [];
  if (p.sex) bits.push(`sex ${p.sex}`);
  if (+p.age) bits.push(`age ${+p.age}`);
  if (+p.heightCm) bits.push(`height ${Math.round(+p.heightCm)} cm`);
  if (+p.weightKg) bits.push(`weight ${r1(+p.weightKg)} kg`);
  bits.push(`activity: ${(ACTIVITY[p.activity] || ACTIVITY.moderate)[1]}`);
  if (p.notes.trim()) bits.push(`notes: "${p.notes.trim().slice(0,300)}"`);
  return bits.join("; ");
}
// Standard estimate: Mifflin-St Jeor resting energy x activity, adjusted for the chosen focus.
function formulaPlan(){
  const p = state.profile, w = +p.weightKg, h = +p.heightCm, age = +p.age;
  if (!w || !h || !age || !p.sex) return null;
  const bmr = 10*w + 6.25*h - 5*age + (p.sex === "female" ? -161 : 5);
  const focus = state.coach.focus;
  const adj = /building muscle/.test(focus) ? 1.10 : /losing fat/.test(focus) ? 0.80 : 1;
  const burn = ouraBurn();
  const kcal = Math.round((burn || bmr * (ACTIVITY[p.activity] || ACTIVITY.moderate)[0]) * adj / 10) * 10;
  const perKg = /losing fat/.test(focus) ? 2.2 : /building muscle/.test(focus) ? 2.0 : /strength/.test(focus) ? 1.8 : /endurance/.test(focus) ? 1.6 : 1.4;
  const prot = Math.round(w * perKg), fat = Math.round(kcal * 0.27 / 9), carbs = Math.max(0, Math.round((kcal - prot*4 - fat*9) / 4));
  return {kcal, p:prot, c:carbs, f:fat, burn};
}

// ---------- micronutrients ----------
const mnum = v => Math.round((+v || 0) * 100) / 100;
const missingMicros = e => MICROS.filter(m => !(e.m && e.m[m.key] != null)).map(m => m.key);
const microTotals = es => Object.fromEntries(MICROS.map(m => [m.key, es.reduce((a,e) => a + (+(e.m && e.m[m.key]) || 0), 0)]));
const fromAIMicros = o => Object.fromEntries(MICROS.map(m => [m.key, Math.max(0, mnum(o && o[m.ai]))]));
const mfmt = (v, unit) => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v*10)/10 : Math.round(v*100)/100).toLocaleString() + " " + unit;
const MICRO_FILL_SCHEMA = {type:"object", additionalProperties:false, required:["items"], properties:{items:{type:"array",
  items:{type:"object", additionalProperties:false, required:["n", ...MICRO_REQ], properties:{n:{type:"integer"}, ...MICRO_PROPS}}}}};
let enrichBusy = false, enrichErr = "", enrichTimer = null;
function queueEnrich(force){
  if (force) enrichErr = "";
  clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => enrichDay(state.date), force ? 0 : 1200);
}
// Ask the AI to fill in whatever micronutrients a day's entries are missing, in one request.
async function enrichDay(k){
  if (!hasAI() || enrichBusy || enrichErr) return;
  const need = entriesFor(k).filter(e => missingMicros(e).length).slice(0, 25);
  if (!need.length) return;
  enrichBusy = true; renderMicros();
  try {
    const lines = need.map((e,i) => {
      const known = MICROS.filter(m => e.m && e.m[m.key] != null).map(m => `${m.ai}=${e.m[m.key]}`).join(", ");
      const t = entryTitle(e);
      return `${i+1}. ${t.title}${t.sub ? ` (${t.sub})` : ""} | ${e.kcal} kcal, protein ${e.p||0} g, carbs ${e.c||0} g, fat ${e.f||0} g${known ? ` | known: ${known}` : ""}`;
    }).join("\n");
    const r = await aiJSON(null,
      "Estimate the micronutrients in each food entry below, for the amount actually eaten. The calories and macros given are for that amount, so use them to judge the portion size. " +
      "Base the numbers on standard food composition data. Where a value is listed as known, return that same value. Use 0 only when the food truly contains essentially none. " +
      "Units: grams for fibre, sugars, saturated fat and omega-3 (ALA+EPA+DHA); milligrams for sodium, potassium, calcium, iron, magnesium, zinc and vitamin C; micrograms for vitamin D, vitamin B12, vitamin A (RAE) and folate (DFE). " +
      "Return one item per entry, with n set to the entry's number.\n\n" + lines, MICRO_FILL_SCHEMA);
    (r.items || []).forEach(it => {
      const e = need[(+it.n || 0) - 1]; if (!e) return;
      const est = fromAIMicros(it); e.m = e.m || {};
      missingMicros(e).forEach(key => { e.m[key] = est[key]; });
      e.mEst = true;
      // Remember per-unit values so adding this food again needs no new estimate.
      if (e.base) { const mult = e.base.qty ? qtyMultiplier(e.base, e.base.qty) : 1; if (mult > 0) { e.base.m = Object.fromEntries(Object.entries(e.m).map(([key, v]) => [key, mnum(v / mult)])); e.base.mEst = true; } }
    });
    persist();
  } catch (err) { enrichErr = aiErrorCopy(err); }
  finally { enrichBusy = false; render(); }
}
document.addEventListener("click", e => { if (e.target.id === "enrichRetry") queueEnrich(true); });

// ---------- views ----------
const VIEW_TITLES = {today:"Today", trends:"Trends", activity:"Activity", review:"Coach", settings:"Settings"};
function show(v, keepScroll){
  if (!VIEW_TITLES[v]) v = "today";
  document.body.dataset.view = v;
  Object.keys(VIEW_TITLES).forEach(k => { $("view-"+k).hidden = k !== v; });
  document.querySelectorAll(".tabbar [data-tab]").forEach(b => b.dataset.tab === v ? b.setAttribute("aria-current","page") : b.removeAttribute("aria-current"));
  if (!keepScroll) window.scrollTo(0, 0);
  if (v === "trends" || v === "review") queueEnrich();
  if (v === "activity" && ouraOn() && Date.now() - state.oura.fetched > 5 * 60000) syncOura();
  if (v === "settings") { renderDataInfo(); renderDiag(); }
  try { history.replaceState(null, "", "#" + v); } catch {}
  render();
}
document.querySelector(".tabbar").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  if (b.dataset.tab === "add") return openAdd();
  show(b.dataset.tab);
});
$("settingsBtn").addEventListener("click", () => show(document.body.dataset.view === "settings" ? "today" : "settings"));
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEW_TITLES[v] && v !== document.body.dataset.view) { closeAll(); show(v); } });

// Render the header and whichever view is showing.
function render(){
  const v = document.body.dataset.view, isToday = state.date === todayKey();
  $("viewTitle").textContent = v === "today" ? dayTitle(state.date) : VIEW_TITLES[v];
  $("subTitle").hidden = v === "today" || v === "settings" || isToday;
  $("subTitle").textContent = isToday ? "" : parseKey(state.date).toLocaleDateString(undefined, {weekday:"long", month:"long", day:"numeric"});
  $("toToday").hidden = isToday;
  $("next").disabled = isToday;
  if (v === "today") renderToday();
  else if (v === "trends") { renderWeek(); renderWeight(); renderMicros(); }
  else if (v === "activity") renderActivity();
  else if (v === "review") renderReview();
  else if (v === "settings") renderDataInfo();
}

// ---------- today ----------
function renderToday(){
  const k = state.date, es = entriesFor(k), t = totals(es), s = targetsFor(k), od = state.oura.days[k];
  const left = s.goal - t.kcal, over = left < 0;
  $("summary").classList.toggle("over", over);
  $("sumBig").textContent = fmt(Math.abs(left));
  $("sumUnit").textContent = over ? "kcal over" : "kcal left";
  $("sumBar").style.width = `${s.goal ? Math.min(100, t.kcal / s.goal * 100) : 0}%`;
  $("sumLine").innerHTML = `<span><b>${fmt(t.kcal)}</b> eaten</span><span>${od && od.total_kcal ? `<b>${fmt(od.total_kcal)}</b> burned · ` : ""}<b>${fmt(s.goal)}</b> goal${state.dayTargets[k] ? "*" : ""}</span>`;
  $("macros").innerHTML = [["Protein","p","--protein"],["Carbs","c","--carbs"],["Fat","f","--fat"]].map(([n,key,col]) => {
    const pct = s[key] ? Math.min(t[key]/s[key]*100,100) : 0;
    return `<div class="macro"><span class="nm">${n}</span><span class="v num">${fmt(t[key])}<small> / ${fmt(s[key])} g</small></span><div class="mini-bar"><i style="width:${pct}%;background:var(${col})"></i></div></div>`;
  }).join("");
  renderOuraTip(); renderCoachRow();
  const yesterday = entriesFor(shift(k, -1));
  $("meals").innerHTML = MEALS.map(([mk, mn]) => {
    const list = es.filter(e => e.meal === mk), mt = totals(list), y = yesterday.filter(e => e.meal === mk);
    const rows = list.map(e => { const tt = entryTitle(e);
      return `<button type="button" class="row" data-entry="${esc(e.id)}"><span class="grow"><span class="title">${esc(tt.title)}</span>${tt.sub ? `<span class="sub">${esc(tt.sub)}</span>` : ""}</span><span class="val num">${fmt(e.kcal)}</span>${CHEV}</button>`; }).join("");
    const copy = !list.length && y.length ? `<button type="button" class="row add" data-copy="${mk}"><span class="grow">Same as yesterday</span><span class="val num muted">${fmt(totals(y).kcal)} kcal</span></button>` : "";
    return `<section class="section"><div class="section-h"><h2>${mn}</h2><span class="t-sub num">${list.length ? `${fmt(mt.kcal)} kcal` : ""}</span></div>
      <div class="group">${rows}${copy}<button type="button" class="row add" data-add="${mk}">${PLUS}<span class="grow">Add food</span></button></div></section>`;
  }).join("");
}
function renderOuraTip(){
  const el = $("ouraTip"), k = state.date, isRecent = k === todayKey() || k === shift(todayKey(), -1);
  const applied = state.dayTargets[k], sg = ouraSuggestion(k);
  const line = t => `${fmt(t.goal)} kcal · P ${fmt(t.p)} · C ${fmt(t.c)} · F ${fmt(t.f)} g`;
  if (applied) {
    const changed = sg && !sg.none && Math.abs(sg.goal - applied.goal) >= 100;
    el.innerHTML = `<div class="card" style="display:grid;gap:10px"><div><p class="t-head">*Adjusted for activity</p><p class="t-sub num">${line(applied)}</p></div>
      <div class="btn-row">${changed ? `<button type="button" class="btn small" data-oura="apply">Update to ${fmt(sg.goal)} kcal</button>` : ""}<button type="button" class="btn small secondary" data-oura="undo">Use usual targets</button></div></div>`;
  } else if (sg && !sg.none && isRecent) {
    const d = sg.goal - state.settings.goal;
    el.innerHTML = `<div class="card" style="display:grid;gap:10px"><div><p class="t-head">${d > 0 ? `Eat about ${fmt(d)} kcal more ${dayName(k)}` : `Adjust macros ${dayName(k)}`}</p><p class="t-sub num">${line(sg)}</p></div>
      <details class="more"><summary>Why</summary><div class="inner">${sg.why.map(w => `<p class="msg">${esc(w)}</p>`).join("")}</div></details>
      <div class="btn-row"><button type="button" class="btn small" data-oura="apply">Use for ${esc(dayName(k))}</button></div></div>`;
  } else { el.hidden = true; return; }
  el.hidden = false;
}
$("ouraTip").addEventListener("click", e => {
  const b = e.target.closest("[data-oura]"); if (!b) return;
  const k = state.date;
  if (b.dataset.oura === "apply") {
    const sg = ouraSuggestion(k); if (!sg || sg.none) return;
    state.dayTargets[k] = {goal:sg.goal, p:sg.p, c:sg.c, f:sg.f};
    toast(`Goal for ${dayName(k)}: ${fmt(sg.goal)} kcal`);
  } else { delete state.dayTargets[k]; toast("Back to your usual targets"); }
  persist(); render();
});
function renderCoachRow(){
  const el = $("coachRow"), k = state.date, es = entriesFor(k), rv = state.reviews[k];
  if (!hasAI() || !es.length) { el.hidden = true; return; }
  el.hidden = false;
  let inner;
  if (rv) { const sc = clampScore(rv.result.score); inner = `${scoreRing(sc, true)}<span class="grow"><span class="title">${esc(rv.result.headline || "")}</span><span class="sub">${rvCtl ? "Updating…" : "Coach"}</span></span>`; }
  else if (rvCtl) inner = `<span class="spin"></span><span class="grow">Reviewing your day…</span>`;
  else if (rvError) inner = `<span class="grow"><span class="title">Coach</span><span class="sub" style="color:var(--warn)">${esc(rvError)}</span></span>`;
  else inner = `<span class="grow"><span class="title">Coach</span><span class="sub">${state.coach.auto ? "Reviews your day shortly" : "Tap for feedback on your day"}</span></span>`;
  el.innerHTML = `<div class="group"><button type="button" class="row" data-go-review>${inner}${CHEV}</button></div>`;
}
$("coachRow").addEventListener("click", e => { if (e.target.closest("[data-go-review]")) show("review"); });
$("meals").addEventListener("click", e => {
  const en = e.target.closest("[data-entry]"); if (en) return editEntry(en.dataset.entry);
  const a = e.target.closest("[data-add]"); if (a) return openAdd(a.dataset.add);
  const c = e.target.closest("[data-copy]");
  if (c) {
    const k = c.dataset.copy, day = state.date, src = entriesFor(shift(day, -1)).filter(x => x.meal === k), now = Date.now();
    const copies = src.map((x, i) => ({...x, id: uid(), t: now + i, u: undefined}));
    state.days[day] = [...entriesFor(day), ...copies]; persist(); render();
    toast(`Added yesterday's ${mealLabel(k).toLowerCase()}`, () => {
      const ids = new Set(copies.map(x => x.id)); state.days[day] = entriesFor(day).filter(x => !ids.has(x.id)); persist(); render();
    });
  }
});
$("prev").addEventListener("click", () => { state.date = shift(state.date,-1); rvError = ""; render(); });
$("next").addEventListener("click", () => { if (state.date < todayKey()) { state.date = shift(state.date,1); rvError = ""; render(); } });
$("toToday").addEventListener("click", () => { state.date = todayKey(); state.meal = defaultMeal(); render(); });
// Coming back to the app on a new day should land on today.
let lastToday = todayKey();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (ouraOn() && Date.now() - state.oura.fetched > 5 * 60000) syncOura();
  if (ouraOn() && ouraStale()) kickOura();
  syncLedger();
  const now = todayKey();
  if (now !== lastToday) { if (state.date === lastToday) state.date = now; lastToday = now; state.meal = defaultMeal(); render(); }
});

// ---------- entries ----------
function logEntries(list, day = state.date){
  state.days[day] = [...entriesFor(day), ...list];
  persist(); closeAll(); if (document.body.dataset.view !== "today") show("today"); else render();
  enrichErr = ""; queueEnrich(); setTimeout(decomposeFoods, 4000);
  const kcal = list.reduce((a, e) => a + e.kcal, 0);
  toast(list.length === 1 ? `Added ${entryTitle(list[0]).title} · ${fmt(kcal)} kcal` : `Added ${list.length} items · ${fmt(kcal)} kcal`, () => {
    const ids = new Set(list.map(x => x.id)); state.days[day] = entriesFor(day).filter(x => !ids.has(x.id)); persist(); render();
  });
}
function addFood(food, qty, meal){
  const e = makeEntry(food, qty, meal, {id: uid()});
  if (!e) return toast("Couldn't work out that amount.");
  if (food.parts) e.parts = food.parts;
  logEntries([e]);
}
function findEntry(id){
  for (const [day, list] of Object.entries(state.days)) { const e = list.find(x => x.id === id); if (e) return {day, e}; }
  return null;
}
function replaceEntry(day, id, next){
  state.days[day] = entriesFor(day).map(x => x.id === id ? next : x);
  persist(); render(); enrichErr = ""; queueEnrich();
}
function removeEntry(id){
  const hit = findEntry(id); if (!hit) return;
  const {day, e} = hit, list = entriesFor(day), idx = list.indexOf(e);
  state.days[day] = list.filter(x => x.id !== id);
  persist(); closeAll(); render();
  toast(`Removed ${entryTitle(e).title}`, () => {
    const cur = [...entriesFor(day)]; cur.splice(Math.min(idx, cur.length), 0, e);
    state.days[day] = cur; persist(); render();
  });
}
function editEntry(id){
  const hit = findEntry(id); if (!hit) return;
  if (hit.e.parts && hit.e.parts.length) return openAIEdit(hit.e, hit.day);
  openFood(foodOf(hit.e), {mode: "edit", entry: hit.e, day: hit.day});
}

// ---------- sheets ----------
const stack = [];
const onClose = {};
function openSheet(name){
  const i = stack.indexOf(name); if (i >= 0) stack.splice(i, 1);
  if (stack.length) $("sheet-" + stack[stack.length - 1]).classList.remove("on");
  stack.push(name);
  const el = $("sheet-" + name); el.classList.add("on"); el.setAttribute("aria-hidden", "false");
  $("scrim").classList.add("on"); document.body.classList.add("locked");
}
function closeSheet(){
  const name = stack.pop(); if (!name) return;
  const el = $("sheet-" + name); el.classList.remove("on"); el.setAttribute("aria-hidden", "true");
  if (onClose[name]) onClose[name]();
  if (stack.length) $("sheet-" + stack[stack.length - 1]).classList.add("on");
  else { $("scrim").classList.remove("on"); document.body.classList.remove("locked"); }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".sheet:not(.on)")) document.activeElement.blur();
}
function closeAll(){ while (stack.length) closeSheet(); }
document.querySelectorAll(".sheet").forEach(s => s.setAttribute("aria-hidden", "true"));
$("scrim").addEventListener("click", closeSheet);
document.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && stack.length && $("scanner").hidden) closeSheet(); });

// ---------- add sheet: search, actions and your usual foods ----------
const mealSegHTML = cur => MEALS.map(([k, n]) => `<button type="button" data-m="${k}" aria-pressed="${k === cur}">${n}</button>`).join("");
// From the tab bar the meal follows the time of day; from a meal's own "Add food" row it's that meal.
function openAdd(meal){
  state.meal = meal || (state.date === todayKey() ? defaultMeal() : state.meal);
  $("q").value = ""; online = null; renderAdd(); openSheet("add");
}
function renderAdd(){
  $("mealSeg").innerHTML = mealSegHTML(state.meal);
  $("addTitle").textContent = `Add to ${mealLabel(state.meal)}`;
  renderAddList();
}
$("mealSeg").addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (b) { state.meal = b.dataset.m; renderAdd(); } });
let addListFoods = [], online = null, searchCtl = null;
const foodRow = (f, i, sub) => `<div class="row tap" data-food="${i}" role="button" tabindex="0"><span class="grow"><span class="title">${esc(f.name)}</span><span class="sub">${sub}</span></span><button type="button" class="qadd" data-qadd="${i}" aria-label="Add ${esc(f.name)}">${PLUS}</button></div>`;
function renderAddList(){
  const q = $("q").value.trim(), out = $("addList");
  if (!q) {
    const rec = recents(15);
    addListFoods = rec.map(r => r.food);
    $("addActions").hidden = false;
    out.innerHTML = rec.length
      ? `<div class="section"><div class="section-h"><h2>Recent</h2></div><div class="group">${rec.map((r, i) => { const n = nutrientsFor(r.food, defaultQty(r.food));
          return foodRow(r.food, i, `${esc(qtyLabelOf(r.food))} · ${fmt(n ? n.kcal : 0)} kcal`); }).join("")}
          <button type="button" class="row add" data-manual>${PLUS}<span class="grow">Enter manually</span></button></div></div>`
      : `<div class="group"><p class="empty">Foods you log show up here for one-tap adding.</p><button type="button" class="row add" data-manual>${PLUS}<span class="grow">Enter manually</span></button></div>`;
    return;
  }
  $("addActions").hidden = true;
  if (!seFoods) loadSwedishFoods().then(() => { if ($("q").value.trim() === q) renderAddList(); });
  const mine = recents(60).map(r => r.food).filter(f => searchFoods([{...f, key: fold(f.name)}], q, 1).length).slice(0, 3);
  const seen = new Set(mine.map(f => fold(f.name)));
  const se = searchFoods(seFoods || [], q, 12).filter(f => !seen.has(fold(f.name))).slice(0, 10);
  addListFoods = [...mine, ...se, ...((online && online.q === q && online.items) || [])];
  const per100 = f => f.unit === "100 g" ? ` · ${fmt(f.kcal)} kcal / 100 g` : ` · ${fmt(f.kcal)} kcal`;
  let html = "";
  if (mine.length) html += `<div class="section"><div class="section-h"><h2>Your foods</h2></div><div class="group">${mine.map((f, i) => { const n = nutrientsFor(f, defaultQty(f)); return foodRow(f, i, `${esc(qtyLabelOf(f))} · ${fmt(n ? n.kcal : 0)} kcal`); }).join("")}</div></div>`;
  if (se.length) html += `<div class="section"><div class="section-h"><h2>Food database</h2></div><div class="group">${se.map((f, i) => foodRow(f, mine.length + i, `${esc(f.en || "")}${per100(f)}`)).join("")}</div></div>`;
  else if (!seFoods) html += `<div class="group"><p class="empty">${working("Loading the food database…")}</p></div>`;
  if (online && online.q === q) {
    const off = mine.length + se.length;
    html += `<div class="section"><div class="section-h"><h2>USDA</h2></div><div class="group">${online.busy ? `<p class="empty">${working("Searching…")}</p>` :
      online.items.length ? online.items.map((f, i) => foodRow(f, off + i, `${f.branded ? "Brand" : "Generic"}${per100(f)}`)).join("") : `<p class="empty">${esc(online.error || "No matches.")}</p>`}</div></div>`;
  }
  html += `<div class="group">${!online || online.q !== q ? `<button type="button" class="row add" data-online><span class="grow">Search USDA for “${esc(q)}”</span></button>` : ""}<button type="button" class="row add" data-manual>${PLUS}<span class="grow">Enter “${esc(q)}” manually</span></button></div>`;
  out.innerHTML = html;
}
const qtyLabelOf = f => { const q = defaultQty(f), opt = unitOptions(f).find(o => o.id === q.unit); if (!opt) return ""; return opt.id === "g" || opt.id === "ml" ? `${toInput(q.amount)} ${opt.label}` : opt.mult != null ? (q.amount === 1 ? `1 ${opt.label}` : `${toInput(q.amount)} × ${opt.label}`) : `${toInput(q.amount)} ${opt.label}`; };
let qTimer = null;
$("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(renderAddList, 120); });
$("q").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if ($("q").value.trim()) searchOnline(); } });
$("addList").addEventListener("click", e => {
  const qa = e.target.closest("[data-qadd]");
  if (qa) { const f = addListFoods[+qa.dataset.qadd]; return addFood(f, defaultQty(f), state.meal); }
  const r = e.target.closest("[data-food]");
  if (r) return openFood(addListFoods[+r.dataset.food], {mode: "add"});
  if (e.target.closest("[data-online]")) return searchOnline();
  if (e.target.closest("[data-manual]")) return openManual($("q").value.trim());
});
$("addList").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-food]")) { e.preventDefault(); e.target.click(); } });
$("addActions").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  // These run straight from the tap so iPhone allows the photo picker and camera to open.
  if (act === "photo") { if (!hasAI()) return needKey(); $("mealFile").click(); }
  else if (act === "scan") { openBarcode(); startScanner(); }
  else if (act === "describe") { if (!hasAI()) return needKey(); $("descText").value = ""; $("descGo").disabled = true; openSheet("describe"); $("descText").focus(); }
});
function needKey(){ closeAll(); show("settings"); $("keysCard").scrollIntoView({block:"center"}); toast("Add a free Gemini key to use AI estimates"); }

async function searchOnline(){
  const q = $("q").value.trim(); if (!q) return;
  if (searchCtl) searchCtl.abort();
  const ctl = searchCtl = new AbortController();
  online = {q, busy: true, items: []}; renderAddList();
  // One request for all food types keeps within USDA's hourly search allowance.
  const all = await searchUSDA(q, ["Foundation","SR Legacy","Survey (FNDDS)","Branded"], 25, ctl.signal);
  if (ctl.signal.aborted) return;
  const items = [...all.items.filter(f => !f.branded).slice(0, 8), ...all.items.filter(f => f.branded).slice(0, 6)];
  online = {q, busy: false, items, error: all.error};
  renderAddList();
}

// Swedish Food Agency database, bundled with the app (data/livsmedel.json) and searched on the device.
let seFoods = null, seLoading = null;
function loadSwedishFoods(){
  if (seFoods) return Promise.resolve(seFoods);
  return seLoading ||= fetch("data/livsmedel.json").then(r => { if (!r.ok) throw 0; return r.json(); }).then(d => {
    const ix = Object.fromEntries(d.fields.map((k,i) => [k,i]));
    seFoods = d.foods.map(row => {
      const m = {};
      MICROS.forEach(mc => { const v = row[ix[mc.key]]; if (v != null) m[mc.key] = v; });
      return {name: row[ix.sv], en: row[ix.en] || "", kcal: row[ix.kcal], p: row[ix.p] || 0, c: row[ix.c] || 0, f: row[ix.f] || 0,
        unit: "100 g", portions: [], source: "Livsmedelsverket", m, key: fold(row[ix.sv] + " | " + (row[ix.en] || ""))};
    });
    return seFoods;
  }).catch(() => { seLoading = null; return []; });
}
async function usdaFetch(params, signal){
  const qs = Object.entries({api_key: keys.usda || "DEMO_KEY", ...params}).flatMap(([k,v]) =>
    (Array.isArray(v) ? v : [v]).map(x => `${k}=${encodeURIComponent(x)}`)).join("&");
  const res = await fetch("https://api.nal.usda.gov/fdc/v1/foods/search?" + qs, {signal});
  if (res.status === 429) throw {limit:true};
  if (res.status === 403) throw {badKey:true};
  // USDA's gateway sometimes rejects the "Survey (FNDDS)" dataset from browsers. Search again without it.
  if (res.status === 400 && Array.isArray(params.dataType) && params.dataType.includes("Survey (FNDDS)"))
    return usdaFetch({...params, dataType: params.dataType.filter(t => t !== "Survey (FNDDS)")}, signal);
  if (!res.ok) throw {http:res.status};
  return res.json();
}
async function searchUSDA(q, dataType, pageSize, signal){
  try {
    const data = await usdaFetch({query:q, pageSize, dataType}, signal);
    return {items:(data.foods || []).map(fromUSDA).filter(Boolean)};
  } catch (e) {
    if (signal && signal.aborted) return {items:[]};
    if (e && e.limit) return {items:[], error:"The shared USDA key has hit its hourly limit. Add your own free key in Settings, or try again later."};
    if (e && e.badKey) return {items:[], error: keys.usda ? "USDA rejected your key. Check it in Settings." : "USDA rejected the shared key. Add your own free key in Settings."};
    return {items:[], error: e && e.http ? `USDA search is unavailable right now (error ${e.http}).` : "Couldn't reach USDA. Check your connection."};
  }
}
function fromUSDA(f){
  const n = (num, id) => { const x = (f.foodNutrients || []).find(v => v.nutrientNumber === num || v.nutrientId === id); return x ? x.value : null; };
  const kcal = n("208", 1008) ?? n("957", 2047) ?? n("958", 2048);
  if (kcal == null) return null;
  const branded = f.dataType === "Branded", liquid = branded && /^(ml|mlt)$/i.test(f.servingSizeUnit || "");
  const portions = [];
  if (branded && f.servingSize > 0 && /^(g|grm|ml|mlt)$/i.test(f.servingSizeUnit || "")) {
    portions.push({label:`serving${f.householdServingFullText ? ` (${f.householdServingFullText})` : ""}`, g:f.servingSize});
  }
  (f.foodMeasures || []).filter(m => m.gramWeight > 0 && m.disseminationText && !/not specified/i.test(m.disseminationText))
    .forEach(m => portions.push({label: m.disseminationText, g:m.gramWeight}));
  const brand = branded ? titleCase(f.brandName || f.brandOwner || "") : "";
  let name = titleCase(f.description);
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`;
  const m = {}, put = (key, v) => { if (v != null) m[key] = mnum(v); };
  put("fiber", n("291",1079)); put("sugar", n("269",2000)); put("satfat", n("606",1258)); put("sodium", n("307",1093)); put("potassium", n("306",1092));
  put("calcium", n("301",1087)); put("iron", n("303",1089)); put("magnesium", n("304",1090)); put("zinc", n("309",1095)); put("vitc", n("401",1162));
  put("vitd", n("328",1114)); put("b12", n("418",1178)); put("vita", n("320",1106)); put("folate", n("435",1190) ?? n("417",1177));
  const ala = n("851",1404) ?? n("619",1270), lc = [n("629",1278), n("621",1272), n("631",1280)];
  if (ala != null || lc.some(v => v != null)) put("omega3", (ala || 0) + lc.reduce((a,v) => a + (v || 0), 0));
  // Branded liquids are reported per 100 ml; treat 1 ml as one unit of that basis.
  return {name, kcal, p:n("203",1003)||0, c:n("205",1005)||0, f:n("204",1004)||0, unit:"100 g", portions, source:"USDA", m, branded, ml: liquid ? 1 : undefined};
}
function fromOFF(p){
  if (!p) return null;
  const n = p.nutriments || {};
  const brand = Array.isArray(p.brands) ? p.brands[0] : String(p.brands || "").split(",")[0].trim();
  const pname = String(p.product_name_sv || p.product_name || "").trim();
  if (!pname && !brand) return null;
  const name = (brand && !pname.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${pname}` : pname || brand).trim();
  const servG = parseFloat(p.serving_quantity);
  // Open Food Facts stores minerals and vitamins in grams.
  const offMicros = sfx => {
    const m = {}, put = (key, field, mul) => { const v = n[field + sfx]; if (typeof v === "number") m[key] = mnum(v * mul); };
    put("fiber","fiber",1); put("sugar","sugars",1); put("satfat","saturated-fat",1); put("omega3","omega-3-fat",1);
    put("sodium","sodium",1e3); put("potassium","potassium",1e3); put("calcium","calcium",1e3); put("iron","iron",1e3); put("magnesium","magnesium",1e3); put("zinc","zinc",1e3); put("vitc","vitamin-c",1e3);
    put("vitd","vitamin-d",1e6); put("b12","vitamin-b12",1e6); put("vita","vitamin-a",1e6); put("folate","vitamin-b9",1e6);
    return m;
  };
  let kcal100 = n["energy-kcal_100g"];
  if (kcal100 == null && n["energy_100g"] != null) kcal100 = n["energy_100g"] / 4.184;
  if (kcal100 != null) {
    return {name, kcal:r1(kcal100), p:n.proteins_100g||0, c:n.carbohydrates_100g||0, f:n.fat_100g||0, unit:"100 g",
      portions: servG > 0 ? [{label: p.serving_size && /\d/.test(p.serving_size) ? String(p.serving_size) : `serving (${Math.round(servG)} g)`, g:servG}] : [], source:"Open Food Facts", m:offMicros("_100g")};
  }
  if (n["energy-kcal_serving"] != null) {
    return {name, kcal:n["energy-kcal_serving"], p:n.proteins_serving||0, c:n.carbohydrates_serving||0, f:n.fat_serving||0, unit:"serving", servingLabel: p.serving_size ? `serving (${p.serving_size})` : "serving", source:"Open Food Facts", m:offMicros("_serving")};
  }
  return null;
}

// ---------- food sheet: choose an amount, or change a logged one ----------
let fs = null;
function openFood(food, {mode = "add", entry = null, day = null, barcode = null} = {}){
  const qty = mode === "edit" ? normalizeQty(food, (entry.base && entry.base.qty) || {amount: 1, unit: "serving"}) : defaultQty(food);
  fs = {food: {...food, qty: undefined}, qty, meal: entry ? entry.meal : state.meal, mode, entry, day, barcode, amountOk: true, busy: false};
  renderFood(); openSheet("food");
}
const factsRows = (food) => {
  const per = food.unit === "100 g" ? (food.ml === 1 ? "100 ml" : "100 g") : (food.servingLabel || "serving");
  const rows = [["Calories", `${fmt(food.kcal)} kcal`], ["Protein", `${g(food.p)} g`], ["Carbohydrate", `${g(food.c)} g`], ["Fat", `${g(food.f)} g`]];
  if (food.m) [["fiber","Fibre"],["sugar","Sugars"],["satfat","Saturated fat"],["sodium","Sodium"]].forEach(([k, l]) => { if (food.m[k] != null) rows.push([l, mfmt(food.m[k], MICROS.find(m => m.key === k).unit)]); });
  return `<p class="t-foot" style="margin-bottom:4px">Per ${esc(per)}${food.source ? ` · ${esc(food.source)}` : ""}</p><div class="facts">${rows.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join("")}</div>`;
};
function renderFood(){
  const {food, qty, mode} = fs, opts = unitOptions(food);
  $("foodTitle").textContent = mode === "edit" ? "Edit" : "Add food";
  $("foodBody").innerHTML = `
    <div class="food-hero"><h3 class="t-title">${esc(food.name)}</h3>${food.en && food.en !== food.name ? `<p class="t-sub">${esc(food.en)}</p>` : ""}
      <div class="big num" id="fsKcal" style="margin-top:8px"></div></div>
    <div class="macro-strip num" id="fsMacros"></div>
    <div class="amount">
      <div class="field"><label for="fsAmt">Amount</label><input id="fsAmt" class="input num" inputmode="decimal" autocomplete="off" value="${esc(toInput(qty.amount))}"><span class="ferr" id="fsAmtErr"></span></div>
      <div class="field"><label for="fsUnit">Unit</label><select id="fsUnit" class="input" ${opts.length < 2 ? "disabled" : ""}>${opts.map(o => `<option value="${esc(o.id)}" ${o.id === qty.unit ? "selected" : ""}>${esc(o.label)}${o.g && o.id !== "g" && o.id !== "ml" && !/\(\d/.test(o.label) ? ` (${toInput(roundGrams(o.g), 1)} g)` : ""}</option>`).join("")}</select></div>
    </div>
    <div class="seg" id="fsMeal" role="group" aria-label="Meal">${mealSegHTML(fs.meal)}</div>
    <details class="more card"><summary>Nutrition details</summary><div class="inner">${factsRows(food)}</div></details>
    ${mode === "edit" ? `<details class="more card" id="fsFix"><summary>Correct the values</summary><div class="inner">
      <p class="t-foot">For the amount above. Future amounts scale from these.</p>
      <div class="grid4"><div class="field"><label for="fxK">kcal</label><input id="fxK" class="input num" inputmode="decimal"></div><div class="field"><label for="fxP">Protein</label><input id="fxP" class="input num" inputmode="decimal"></div><div class="field"><label for="fxC">Carbs</label><input id="fxC" class="input num" inputmode="decimal"></div><div class="field"><label for="fxF">Fat</label><input id="fxF" class="input num" inputmode="decimal"></div></div>
      <span class="ferr" id="fxErr"></span></div></details>` : ""}`;
  $("foodFoot").innerHTML = mode === "edit"
    ? `<button type="button" class="btn wide" id="fsSave">Save</button><button type="button" class="btn wide danger" id="fsDel">Delete</button>`
    : `<button type="button" class="btn wide" id="fsAdd"></button>`;
  updateFoodNumbers();
  if (mode === "edit") { const n = nutrientsFor(food, qty); if (n) { $("fxK").value = toInput(n.kcal, 0); $("fxP").value = toInput(n.p, 1); $("fxC").value = toInput(n.c, 1); $("fxF").value = toInput(n.f, 1); } }
}
function updateFoodNumbers(){
  const r = readField("fsAmt", {required: true, allowZero: false, max: 100000});
  fs.amountOk = !r.error;
  if (!r.error) fs.qty = {amount: r.value, unit: fs.qty.unit};
  const n = fs.amountOk ? nutrientsFor(fs.food, fs.qty) : null;
  const grams = fs.amountOk ? qtyGrams(fs.food, fs.qty) : null, opt = unitOptions(fs.food).find(o => o.id === fs.qty.unit);
  $("fsKcal").innerHTML = n ? `${fmt(n.kcal)}<small> kcal${grams != null && opt && opt.id !== "g" ? ` · ${toInput(roundGrams(grams), 1)} g` : ""}</small>` : "–";
  $("fsMacros").innerHTML = [["Protein","p","--protein"],["Carbs","c","--carbs"],["Fat","f","--fat"]].map(([l, k, c]) => `<div><b>${n ? g(n[k]) : "–"} g</b><span><span class="dot" style="background:var(${c})"></span>${l}</span></div>`).join("");
  const btn = $("fsAdd") || $("fsSave");
  btn.disabled = !n || fs.busy;
  if ($("fsAdd")) $("fsAdd").textContent = n ? `Add to ${mealLabel(fs.meal)} · ${fmt(n.kcal)} kcal` : `Add to ${mealLabel(fs.meal)}`;
}
$("foodBody").addEventListener("input", e => { if (e.target.id === "fsAmt") updateFoodNumbers(); });
$("foodBody").addEventListener("change", e => {
  if (e.target.id !== "fsUnit") return;
  // Switching units keeps the same quantity of food (1 medium banana becomes 120 g).
  const opts = unitOptions(fs.food), next = opts.find(o => o.id === e.target.value), cur = opts.find(o => o.id === fs.qty.unit);
  if (fs.amountOk && cur && next && cur.g && next.g) {
    const grams = fs.qty.amount * cur.g, a = grams / next.g;
    fs.qty = {amount: next.id === "g" || next.id === "ml" ? roundGrams(a) : Math.round(a * 100) / 100, unit: next.id};
  } else fs.qty = {amount: fs.amountOk ? fs.qty.amount : 1, unit: next.id};
  $("fsAmt").value = toInput(fs.qty.amount); updateFoodNumbers();
});
$("foodBody").addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (!b) return; fs.meal = b.dataset.m; $("fsMeal").innerHTML = mealSegHTML(fs.meal); updateFoodNumbers(); });
$("foodBody").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "fsAmt") { e.preventDefault(); ($("fsAdd") || $("fsSave")).click(); } });
$("foodFoot").addEventListener("click", e => {
  if (!fs) return;
  if (e.target.id === "fsAdd") {
    if (!fs.amountOk || fs.busy) return;
    fs.busy = true; e.target.disabled = true;
    if (fs.barcode) state.barcodes[fs.barcode] = {...fs.food, qty: undefined};
    state.meal = fs.meal; addFood(fs.food, fs.qty, fs.meal);
  } else if (e.target.id === "fsSave") {
    if (!fs.amountOk) return;
    let next = remeasure({...fs.entry, base: {...foodOf(fs.entry), qty: fs.entry.base && fs.entry.base.qty}}, fs.qty);
    next.meal = fs.meal;
    if ($("fsFix") && $("fsFix").open) {
      // Corrected totals for this amount: store them, and rebase the food so other amounts scale from them.
      const vals = ["fxK","fxP","fxC","fxF"].map(id => readAmount($(id).value, {max: 20000}));
      const bad = vals.find(v => v.error || v.value == null);
      if (bad) { $("fxErr").textContent = "Enter a number in each field."; return; }
      const [k, p, c, f] = vals.map(v => v.value), mult = qtyMultiplier(next.base, next.base.qty) || 1;
      next = {...next, kcal: Math.round(k), p: r1(p), c: r1(c), f: r1(f), base: {...next.base, kcal: r1(k / mult), p: r1(p / mult), c: r1(c / mult), f: r1(f / mult), source: "Your correction"}};
    }
    replaceEntry(fs.day, fs.entry.id, next); closeAll(); toast("Saved");
  } else if (e.target.id === "fsDel") removeEntry(fs.entry.id);
});

// ---------- manual entry ----------
let manBarcode = null;
function openManual(name = "", barcode = null){
  manBarcode = barcode;
  ["manName","manKcal","manP","manC","manF"].forEach(id => { $(id).value = ""; clearErr(id); });
  $("manName").value = name; $("manServ").value = "1"; clearErr("manServ"); $("manMacroErr").textContent = "";
  $("manHint").textContent = barcode ? `Barcode ${barcode} will remember these values.` : "";
  $("manAdd").textContent = `Add to ${mealLabel(state.meal)}`;
  openSheet("manual"); (name ? $("manKcal") : $("manName")).focus();
}
function submitManual(){
  const name = $("manName").value.trim();
  $("manNameErr").textContent = name ? "" : "Required"; $("manName").setAttribute("aria-invalid", name ? "false" : "true");
  const kcal = readField("manKcal", {required: true, max: 20000}), serv = readField("manServ", {required: true, allowZero: false, max: 1000});
  const [p, c, f] = ["manP","manC","manF"].map(id => readField(id, {max: 2000}));
  if (!name || kcal.error || serv.error || p.error || c.error || f.error) return;
  const food = {name: name.slice(0, 80), kcal: kcal.value, p: p.value || 0, c: c.value || 0, f: f.value || 0, unit: "serving", source: "Your entry"};
  if (manBarcode) state.barcodes[manBarcode] = food;
  addFood(food, {amount: serv.value, unit: "serving"}, state.meal);
}
$("manAdd").addEventListener("click", submitManual);
$("manForm").addEventListener("submit", e => { e.preventDefault(); submitManual(); });
$("manForm").addEventListener("input", () => {
  // A gentle check, not a block: macros that add up to far more than the calories usually mean a typo.
  const v = id => parseDecimal($(id).value) || 0, k = parseDecimal($("manKcal").value);
  const est = 4 * v("manP") + 4 * v("manC") + 9 * v("manF");
  $("manMacroErr").textContent = k > 0 && est > k * 1.3 + 20 ? `These macros add up to about ${fmt(est)} kcal. Check the numbers.` : "";
});

// ---------- barcode ----------
// Barcodes are read with ZXing C++ compiled to WebAssembly (vendor/), which is far faster and more accurate than the JavaScript port.
const READ_OPTS = {formats: ["EAN13", "EAN8", "UPCA", "UPCE"], tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 1};
let wasmReady = null;
function loadReader(){
  return wasmReady ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/zxing-wasm-reader-3.1.4.js";
    s.onload = () => window.ZXingWASM.prepareZXingModule({
      overrides: {locateFile: (path, prefix) => path.endsWith(".wasm") ? new URL("vendor/zxing_reader.wasm", location.href).href : prefix + path},
      fireImmediately: true}).then(res, rej);
    s.onerror = () => rej(new Error("load"));
    document.head.appendChild(s);
  }).catch(() => { wasmReady = null; throw new Error("load"); });
}
// EAN/UPC check digit, so a misread never gets looked up.
function validGTIN(code){
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split("").map(Number), check = d.pop();
  const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === check;
}
async function readCodes(input){
  const found = await window.ZXingWASM.readBarcodes(input, READ_OPTS);
  const hit = (found || []).find(r => r.isValid && validGTIN(r.text));
  return hit ? hit.text : null;
}
async function decodeBarcodePhoto(file){
  if ("BarcodeDetector" in window) {
    try { const bmp = await createImageBitmap(file); const r = await new BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e"]}).detect(bmp); const ok = r && r.find(x => validGTIN(x.rawValue)); if (ok) return ok.rawValue; } catch {}
  }
  await loadReader();
  return readCodes(file);
}
function openBarcode(){
  $("bcOut").innerHTML = ""; $("bcCode").value = "";
  openSheet("barcode"); loadReader().catch(() => {}); loadSwedishBarcodes();
}
// Live scanner: grab the area inside the on-screen frame about 12 times a second and decode it.
// A code is accepted once it has been read twice in a row, which filters out the odd misread.
let scan = null;
async function startScanner(){
  $("scanMsg").textContent = "Starting camera…";
  $("torchBtn").hidden = true;
  $("scanner").hidden = false;
  const video = $("scanVideo");
  try {
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 30}}}),
      loadReader()]);
    if ($("scanner").hidden) { stream.getTracks().forEach(t => t.stop()); return; }   // cancelled while starting
    video.srcObject = stream; await video.play();
    const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({focusMode: "continuous"});
    // Phones with a big main camera can't focus up close; a little zoom lets you hold the phone further away and stay sharp.
    if (caps.zoom && caps.zoom.max >= 1.6) adv.push({zoom: Math.min(2, caps.zoom.max)});
    if (adv.length) track.applyConstraints({advanced: adv}).catch(() => {});
    if (caps.torch) $("torchBtn").hidden = false;
    scan = {stream, track, torch: false, last: "", streak: 0, busy: false, canvas: document.createElement("canvas"), timer: 0, started: Date.now()};
    $("scanMsg").textContent = "Fit the barcode inside the frame, about 15–25 cm away.";
    scanTick();
  } catch (e) {
    stopScanner();
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    $("bcOut").innerHTML = `<p class="msg err">${denied
      ? "Camera access was blocked. Allow the camera (on iPhone: Settings › Safari › Camera), or use a photo of the barcode."
      : e && e.message === "load" ? "The scanner couldn't load. Check your connection and try again."
      : "Couldn't start the camera. Use a photo of the barcode instead."}</p>`;
  }
}
function frameCrop(video){
  // Map the on-screen frame onto the camera image (the video is shown with object-fit: cover), with some margin.
  const vw = video.videoWidth, vh = video.videoHeight, box = video.getBoundingClientRect(), fr = document.querySelector(".scan-frame").getBoundingClientRect();
  const k = Math.max(box.width / vw, box.height / vh), ox = (box.width - vw * k) / 2, oy = (box.height - vh * k) / 2;
  const mx = fr.width * 0.12, my = fr.height * 0.25;
  const x = Math.max(0, (fr.left - box.left - mx - ox) / k), y = Math.max(0, (fr.top - box.top - my - oy) / k);
  const w = Math.min(vw - x, (fr.width + 2 * mx) / k), h = Math.min(vh - y, (fr.height + 2 * my) / k);
  return w > 20 && h > 20 ? {x, y, w, h} : {x: 0, y: 0, w: vw, h: vh};
}
async function scanTick(){
  if (!scan) return;
  const video = $("scanVideo");
  if (!scan.busy && video.readyState >= 2 && video.videoWidth) {
    scan.busy = true;
    try {
      const c = frameCrop(video), sc = Math.min(1, 1280 / c.w);
      const cv = scan.canvas; cv.width = Math.round(c.w * sc); cv.height = Math.round(c.h * sc);
      const ctx = cv.getContext("2d", {willReadFrequently: true});
      ctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
      const code = await readCodes(ctx.getImageData(0, 0, cv.width, cv.height));
      if (scan && code) {
        scan.streak = code === scan.last ? scan.streak + 1 : 1; scan.last = code;
        if (scan.streak >= 2) { if (navigator.vibrate) navigator.vibrate(40); stopScanner(); lookupCode(code); return; }
      }
      if (scan && !code && Date.now() - scan.started > 8000) $("scanMsg").textContent = "Still looking. Move a little further away, avoid glare, and keep the bars sharp.";
    } catch {} finally { if (scan) scan.busy = false; }
  }
  if (scan) scan.timer = setTimeout(scanTick, 80);
}
function stopScanner(){
  if (scan) { clearTimeout(scan.timer); scan.stream.getTracks().forEach(t => t.stop()); scan = null; }
  const v = $("scanVideo"); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
  $("scanner").hidden = true;
}
$("startScan").addEventListener("click", startScanner);
$("scanCancel").addEventListener("click", stopScanner);
$("torchBtn").addEventListener("click", () => {
  if (!scan) return; scan.torch = !scan.torch;
  scan.track.applyConstraints({advanced: [{torch: scan.torch}]}).catch(() => {});
  $("torchBtn").textContent = scan.torch ? "Light off" : "Light";
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("scanner").hidden) stopScanner(); });

const normCode = c => String(c || "").replace(/\D/g, "");
const codeKey = code => code.length === 13 && code[0] === "0" ? code.slice(1) : code; // UPC-A == EAN-13 with a leading 0
// Products sold in Sweden from Open Food Facts, bundled with the app (data/barcodes-se.json) for instant, offline lookups.
let seBarcodes = null, seBarcodesLoading = null;
function loadSwedishBarcodes(){
  if (seBarcodes) return Promise.resolve(seBarcodes);
  return seBarcodesLoading ||= fetch("data/barcodes-se.json").then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(d => (seBarcodes = d.products || {})).catch(() => { seBarcodesLoading = null; return {}; });
}
async function bundledProduct(code){
  const table = await loadSwedishBarcodes();
  const row = table[code] || table[code.padStart(13, "0")] || table[code.replace(/^0+/, "")];
  if (!row) return null;
  const [name, kcal, p, c, f, servG, serving, fiber, sugar, satfat, sodium] = row, m = {};
  [["fiber", fiber], ["sugar", sugar], ["satfat", satfat], ["sodium", sodium]].forEach(([k, v]) => { if (v != null) m[k] = v; });
  return {name, kcal, p: p || 0, c: c || 0, f: f || 0, unit: "100 g", source: "Open Food Facts", m,
    portions: servG > 0 ? [{label: serving && /\d/.test(serving) ? serving : `serving (${Math.round(servG)} g)`, g: servG}] : []};
}
async function fetchOFFProduct(code){
  const tries = [code]; if (code.length === 12) tries.push("0" + code); if (code.length === 13 && code[0] === "0") tries.push(code.slice(1));
  for (const c of tries) {
    const res = await fetch(`${OFF}/api/v2/product/${c}.json?lc=sv&fields=code,product_name,product_name_sv,brands,serving_size,serving_quantity,nutriments`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error("http");
    const data = await res.json();
    if (data.status === 1 && data.product) return data.product;
  }
  return null;
}
let bcPending = null, lblCtl = null;
async function lookupCode(raw, photo){
  if (stack[stack.length - 1] !== "barcode") openSheet("barcode");
  const code = normCode(raw), out = $("bcOut");
  if (code.length < 6) { out.innerHTML = `<p class="msg err">Food barcodes are usually 8, 12 or 13 digits.</p>`; return; }
  $("bcCode").value = code;
  const key = codeKey(code), known = state.barcodes[key];
  if (known) { out.innerHTML = ""; return openFood(known, {mode: "add"}); }
  out.innerHTML = working("Looking up the barcode…");
  let product = null, failed = false;
  let food = await bundledProduct(code);
  if (!food) {
    try { product = await fetchOFFProduct(code); } catch { failed = true; }
    food = fromOFF(product);
  }
  if (!food) {
    out.innerHTML = working("Checking USDA's branded foods…");
    try {
      const data = await usdaFetch({query:code.padStart(14,"0"), dataType:["Branded"], pageSize:3});
      const hit = (data.foods || []).find(f => String(f.gtinUpc || "").replace(/^0+/,"") === code.replace(/^0+/,""));
      food = hit ? fromUSDA(hit) : null;
      if (food) failed = false;
    } catch {}
  }
  if (food) { state.barcodes[key] = food; persist(); out.innerHTML = ""; return openFood(food, {mode: "add"}); }
  bcPending = {key, photo};
  out.innerHTML = `<p class="msg">${failed ? "Couldn't reach Open Food Facts." : product ? "This product has no nutrition data online yet." : `<b class="num">${esc(code)}</b> isn't in the online databases yet.`} Add it once and it's remembered.</p>
    <div class="group">
      ${hasAI() ? `<label class="row add" for="lblFile" style="cursor:pointer"><span class="grow">Photograph the nutrition label</span></label>${photo ? `<button type="button" class="row add" id="lblSame"><span class="grow">Read the photo I took</span></button>` : ""}` : ""}
      <button type="button" class="row add" id="bcManual"><span class="grow">Enter the values</span></button>
    </div>`;
}
$("bcOut").addEventListener("click", e => {
  if (e.target.closest("#bcManual")) openManual("", bcPending && bcPending.key);
  if (e.target.closest("#lblSame") && bcPending) readLabel(bcPending.photo);
  if (e.target.closest("#bcAI") && bcPending) readLabel(bcPending.photo);
});
$("bcLookup").addEventListener("click", () => lookupCode($("bcCode").value));
$("bcCode").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); lookupCode($("bcCode").value); } });
$("bcFile").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  $("bcOut").innerHTML = working("Reading the barcode…");
  let code = null;
  try { code = await decodeBarcodePhoto(file); } catch (err) {
    if (err && err.message === "load") { $("bcOut").innerHTML = `<p class="msg err">The barcode reader couldn't load. Check your connection, or type the number.</p>`; return; }
  }
  if (code) return lookupCode(code, file);
  bcPending = {key: null, photo: file};
  $("bcOut").innerHTML = `<p class="msg err">No barcode found in that photo. Move closer and keep the code flat and sharp, or type the number.</p>
    ${hasAI() ? `<div class="group"><button type="button" class="row add" id="bcAI"><span class="grow">Identify the product with AI</span></button></div>` : ""}`;
});
$("lblFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) readLabel(f); });
async function readLabel(file){
  const out = $("bcOut");
  if (lblCtl) lblCtl.abort();
  const ctl = lblCtl = new AbortController();
  out.innerHTML = working("Reading the package…");
  try {
    const r = await aiJSON(file, LABEL_PROMPT, LABEL_SCHEMA, ctl.signal, "label");
    if (ctl !== lblCtl) return;
    const food = foodFromLabel(r);
    if (!food) { out.innerHTML = `<p class="msg err">Couldn't read that package. Try a sharp photo of the nutrition table, or enter the values.</p><div class="group"><button type="button" class="row add" id="bcManual"><span class="grow">Enter the values</span></button></div>`; return; }
    out.innerHTML = `<p class="msg ${food.source === "AI estimate" ? "" : "ok"}">${food.source === "AI estimate" ? "No legible label, so these are typical values for the product. Check them." : "Read from the label."}</p>`;
    openFood(food, {mode: "add", barcode: bcPending && bcPending.key});
  } catch (err) {
    if (err && err.kind === "cancelled") return;
    out.innerHTML = `<p class="msg err">${esc(aiErrorCopy(err))}</p>`;
  } finally { if (ctl === lblCtl) lblCtl = null; }
}
onClose.barcode = () => { if (lblCtl) { lblCtl.abort(); lblCtl = null; } };

// ---------- AI meal estimates: photo or description, then review ----------
const ai = {req: 0, ctl: null, mode: "photo", file: null, url: "", text: "", meal: null, view: "idle", error: null, entry: null, day: null, scale: 1, busy: false};
$("mealFile").addEventListener("change", e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  if (ai.url) URL.revokeObjectURL(ai.url);
  Object.assign(ai, {mode: "photo", file, url: URL.createObjectURL(file), text: "", entry: null, day: null});
  openSheet("ai"); analyze();
});
$("descText").addEventListener("input", () => { $("descGo").disabled = !$("descText").value.trim(); });
$("descText").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$("descGo").disabled) $("descGo").click(); } });
$("descGo").addEventListener("click", () => {
  const text = $("descText").value.trim(); if (!text) return;
  if (ai.url) URL.revokeObjectURL(ai.url);
  Object.assign(ai, {mode: "text", file: null, url: "", text, entry: null, day: null});
  openSheet("ai"); analyze();
});
// Every request has a number; an answer that arrives after a newer request (or after closing) is ignored.
async function analyze(hint = ""){
  const id = ++ai.req;
  if (ai.ctl) ai.ctl.abort();
  const ctl = ai.ctl = new AbortController();
  ai.view = "loading"; ai.error = null; renderAI();
  try {
    const raw = await aiJSON(ai.mode === "photo" ? ai.file : null, mealPrompt({mode: ai.mode, text: ai.text, hint}), MEAL_SCHEMA, ctl.signal, ai.mode === "photo" ? "meal" : "text");
    if (id !== ai.req) return;
    const res = normalizeMeal(raw);
    if (!res.ok) { ai.view = "error"; ai.error = res; logDiag({task: "meal-check", ok: false, kind: res.kind}); return renderAI(); }
    const db = await loadSwedishFoods();
    if (id !== ai.req) return;
    res.meal.parts = res.meal.parts.map(p => ({...groundPart(p, db), base: p.grams}));
    ai.meal = res.meal; ai.scale = 1; ai.view = "review"; ai.busy = false;
    renderAI();
  } catch (err) {
    if (id !== ai.req || (err && err.kind === "cancelled")) return;
    ai.view = "error"; ai.error = {kind: "api", message: aiErrorCopy(err)}; renderAI();
  } finally { if (id === ai.req) ai.ctl = null; }
}
onClose.ai = () => { ai.req++; if (ai.ctl) ai.ctl.abort(); ai.ctl = null; if (ai.url) { URL.revokeObjectURL(ai.url); ai.url = ""; } ai.file = null; ai.meal = null; ai.view = "idle"; };
function openAIEdit(entry, day){
  if (ai.url) URL.revokeObjectURL(ai.url);
  const parts = entry.parts.map(p => ({...p, on: true, base: p.grams, per: {...p.per}}));
  Object.assign(ai, {mode: "edit", file: null, url: "", text: "", entry, day, scale: 1, busy: false, view: "review",
    meal: {name: entry.name, observations: entry.ai && entry.ai.observations || "", assumptions: entry.ai && entry.ai.assumptions || [], confidence: entry.ai && entry.ai.confidence || "", needsReview: false, parts}});
  ai.meal.meal = entry.meal;
  openSheet("ai"); renderAI();
}
const SCALES = [0.5, 0.75, 1, 1.25, 1.5];
const scaleLabel = s => ({0.5: "½", 0.75: "¾", 1: "1×", 1.25: "1¼", 1.5: "1½"})[s];
function renderAI(){
  const body = $("aiBody"), foot = $("aiFoot");
  const thumb = ai.url ? `<img src="${ai.url}" alt="Your meal photo">` : "";
  $("aiTitle").textContent = ai.mode === "edit" ? "Edit meal" : ai.mode === "photo" ? "Photo estimate" : "Estimate";
  if (ai.view === "loading") {
    body.innerHTML = `<div class="rv-photo">${thumb}<div class="grow" style="display:grid;gap:8px"><span class="skel" style="width:70%;height:20px"></span><span class="skel" style="width:40%"></span></div></div>
      <div class="card" style="display:grid;gap:12px">${working(ai.mode === "photo" ? "Identifying foods and estimating portions…" : "Estimating…")}<span class="skel"></span><span class="skel" style="width:80%"></span><span class="skel" style="width:60%"></span></div>`;
    foot.innerHTML = `<button type="button" class="btn wide secondary" id="aiStop">Stop</button>`;
    return;
  }
  if (ai.view === "error") {
    const e = ai.error || {}, msg = e.kind === "unrecognized" ? `No food recognised${ai.mode === "photo" ? " in that photo" : ""}.${e.message ? " " + e.message : ""}`
      : e.kind === "empty" || e.kind === "malformed" ? "The AI's answer didn't contain a usable estimate, so nothing was filled in." : e.message || "Something went wrong.";
    body.innerHTML = `<div class="rv-photo">${thumb}</div><div class="notice err"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.5"/></svg><span>${esc(msg)}</span></div>
      <div class="field"><label for="aiHint">Add a detail and try again (optional)</label><input id="aiHint" class="input" placeholder="It's a chicken wrap, about 300 g" autocomplete="off"></div>`;
    foot.innerHTML = `<button type="button" class="btn wide" id="aiRetry">Try again</button><div class="btn-row"><button type="button" class="btn secondary" id="aiManual">Enter manually</button>${ai.mode === "photo" ? `<button type="button" class="btn secondary" id="aiDescribe">Describe instead</button>` : ""}</div>`;
    return;
  }
  if (ai.view !== "review" || !ai.meal) { body.innerHTML = ""; foot.innerHTML = ""; return; }
  const m = ai.meal, confText = {high: "High confidence", medium: "Medium confidence", low: "Low confidence"}[m.confidence];
  if (!m.meal) m.meal = state.meal;
  body.innerHTML = `
    <div class="rv-photo">${thumb}<div class="grow"><input class="title-in" id="aiName" value="${esc(m.name)}" aria-label="Meal name" autocomplete="off">${confText ? `<span class="conf ${m.confidence}"><i></i>${confText}</span>` : ""}</div></div>
    <div class="food-hero" style="padding:0"><div class="big num" id="aiKcal"></div></div>
    <div class="macro-strip num" id="aiMacros"></div>
    ${m.needsReview ? `<div class="notice caution"><svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg><span>Some amounts are uncertain. Check the grams before adding.</span></div>` : ""}
    ${m.parts.length > 1 ? `<div class="scale-row"><span class="t-sub">Portion</span><div class="seg" id="aiScale" style="width:min(260px,62%)">${SCALES.map(s => `<button type="button" data-scale="${s}" aria-pressed="${s === ai.scale}">${scaleLabel(s)}</button>`).join("")}</div></div>` : ""}
    <div class="group" id="aiParts">${m.parts.map((p, i) => partHTML(p, i)).join("")}</div>
    <details class="more card"><summary>How this was estimated</summary><div class="inner">
      ${m.observations ? `<p class="msg">${esc(m.observations)}</p>` : ""}
      ${m.assumptions.length ? `<ul class="rv-list">${m.assumptions.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
      <div class="facts">${m.parts.map(p => `<div><span>${esc(p.name)}</span><span>${fmt(p.per.kcal)} kcal/100 g · ${esc(p.source || "")}</span></div>`).join("")}</div>
      <p class="t-foot">Calories are worked out from each item's grams and its nutrition per 100 g. A photo can't show hidden oil or exact depth, so treat the total as an estimate.</p>
    </div></details>
    ${ai.mode !== "edit" ? `<div class="field"><label for="aiHint">Something wrong?</label><div style="display:flex;gap:8px"><input id="aiHint" class="input" placeholder="It's turkey, not chicken" autocomplete="off" enterkeyhint="go"><button type="button" class="btn secondary" id="aiRetry">Redo</button></div></div>` : ""}
    <div class="seg" id="aiMeal" role="group" aria-label="Meal">${mealSegHTML(m.meal)}</div>`;
  foot.innerHTML = ai.mode === "edit"
    ? `<button type="button" class="btn wide" id="aiSave">Save</button><button type="button" class="btn wide danger" id="aiDel">Delete</button>`
    : `<button type="button" class="btn wide" id="aiAdd"></button>`;
  updateAITotals();
}
function partHTML(p, i){
  const n = partNutrients(p), range = p.low && p.high ? `${toInput(p.low, 0)}–${toInput(p.high, 0)} g likely` : "";
  return `<div class="part ${p.on ? "" : "off"}" data-i="${i}">
    <button type="button" class="tick" data-tick="${i}" aria-label="${p.on ? "Leave out" : "Include"} ${esc(p.name)}" aria-pressed="${p.on}"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></button>
    <div class="pmain" style="min-width:0"><input class="pname" data-name="${i}" value="${esc(p.name)}" aria-label="Item name" autocomplete="off">
      <div class="pmeta">${p.household ? `<span>${esc(p.household)}</span>` : ""}${range ? `<span>${range}</span>` : ""}${p.visible === false ? `<span>assumed</span>` : ""}${p.check ? `<span class="flag">check values</span>` : ""}</div></div>
    <div class="pk num" id="pk${i}">${fmt(n.kcal)}<small>kcal</small></div>
    <div class="gctl"><div class="stepper"><button type="button" data-step="-1" data-i="${i}" aria-label="Less">−</button><input class="num" inputmode="decimal" data-g="${i}" value="${esc(toInput(p.grams, 1))}" aria-label="Grams of ${esc(p.name)}" autocomplete="off"><span class="u">g</span><button type="button" data-step="1" data-i="${i}" aria-label="More">+</button></div></div>
  </div>`;
}
function updateAITotals(){
  const m = ai.meal, t = mealTotals(m.parts), on = m.parts.filter(p => p.on).length, bad = m.parts.some(p => p.on && p.bad);
  $("aiKcal").innerHTML = `${fmt(t.kcal)}<small> kcal</small>`;
  $("aiMacros").innerHTML = [["Protein","p","--protein"],["Carbs","c","--carbs"],["Fat","f","--fat"]].map(([l, k, c]) => `<div><b>${g(t[k])} g</b><span><span class="dot" style="background:var(${c})"></span>${l}</span></div>`).join("");
  m.parts.forEach((p, i) => { const el = $("pk" + i); if (el) el.innerHTML = `${fmt(partNutrients(p).kcal)}<small>kcal</small>`; });
  const btn = $("aiAdd") || $("aiSave");
  btn.disabled = !on || bad || ai.busy;
  if ($("aiAdd")) $("aiAdd").textContent = on ? `Add to ${mealLabel(m.meal)} · ${fmt(t.kcal)} kcal` : "Choose at least one item";
}
const gramStep = g0 => g0 < 20 ? 1 : g0 < 60 ? 5 : g0 < 300 ? 10 : 25;
$("aiBody").addEventListener("click", e => {
  const m = ai.meal; if (!m) return;
  const tick = e.target.closest("[data-tick]");
  if (tick) { const p = m.parts[+tick.dataset.tick]; p.on = !p.on; const row = tick.closest(".part"); row.classList.toggle("off", !p.on); tick.setAttribute("aria-pressed", p.on); return updateAITotals(); }
  const st = e.target.closest("[data-step]");
  if (st) {
    const i = +st.dataset.i, p = m.parts[i], step = gramStep(p.grams), dir = +st.dataset.step;
    p.grams = Math.max(step === 1 ? 1 : step, Math.round((p.grams + dir * step) / step) * step); p.base = p.grams / ai.scale; p.bad = false;
    const inp = document.querySelector(`[data-g="${i}"]`); inp.value = toInput(p.grams, 1); inp.removeAttribute("aria-invalid");
    return updateAITotals();
  }
  const sc = e.target.closest("[data-scale]");
  if (sc) {
    ai.scale = +sc.dataset.scale;
    m.parts.forEach((p, i) => { p.grams = roundGrams(p.base * ai.scale); p.bad = false; const inp = document.querySelector(`[data-g="${i}"]`); if (inp) { inp.value = toInput(p.grams, 1); inp.removeAttribute("aria-invalid"); } });
    document.querySelectorAll("#aiScale [data-scale]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.scale === ai.scale));
    return updateAITotals();
  }
  const mb = e.target.closest("#aiMeal [data-m]");
  if (mb) { m.meal = mb.dataset.m; $("aiMeal").innerHTML = mealSegHTML(m.meal); return updateAITotals(); }
  if (e.target.id === "aiRetry") analyze(($("aiHint") || {}).value || "");
});
$("aiBody").addEventListener("input", e => {
  const m = ai.meal; if (!m) return;
  if (e.target.dataset.g != null) {
    const p = m.parts[+e.target.dataset.g], r = readAmount(e.target.value, {required: true, allowZero: false, max: 5000});
    e.target.setAttribute("aria-invalid", r.error ? "true" : "false");
    p.bad = !!r.error;
    if (!r.error) { p.grams = r.value; p.base = r.value / ai.scale; }
    updateAITotals();
  } else if (e.target.dataset.name != null) m.parts[+e.target.dataset.name].name = e.target.value;
  else if (e.target.id === "aiName") m.name = e.target.value;
});
$("aiBody").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "aiHint") { e.preventDefault(); analyze(e.target.value); } });
$("aiFoot").addEventListener("click", e => {
  const id = e.target.id;
  if (id === "aiStop") { ai.req++; if (ai.ctl) ai.ctl.abort(); closeSheet(); }
  else if (id === "aiRetry") analyze(($("aiHint") || {}).value || "");
  else if (id === "aiManual") { closeAll(); openManual(ai.text.slice(0, 80)); }
  else if (id === "aiDescribe") { closeAll(); $("descText").value = ""; $("descGo").disabled = true; openSheet("describe"); $("descText").focus(); }
  else if (id === "aiAdd" || id === "aiSave") {
    if (ai.busy) return;
    const entry = aiEntry(); if (!entry) return;
    ai.busy = true; e.target.disabled = true;
    if (id === "aiAdd") { state.meal = entry.meal; logEntries([entry]); }
    else { replaceEntry(ai.day, ai.entry.id, {...ai.entry, ...entry, id: ai.entry.id, t: ai.entry.t}); closeAll(); toast("Saved"); }
  } else if (id === "aiDel") removeEntry(ai.entry.id);
});
// The reviewed estimate becomes one log entry holding its parts, so it can be opened and adjusted later.
function aiEntry(){
  const m = ai.meal, on = m.parts.filter(p => p.on);
  if (!on.length || on.some(p => p.bad)) return null;
  const t = mealTotals(on), name = (m.name || "").trim().slice(0, 80) || on.map(p => p.name).join(", ");
  const grams = on.reduce((a, p) => a + p.grams, 0);
  const parts = on.map(p => ({name: (p.name || "").trim() || "Food", grams: p.grams, household: p.household || "", per: p.per, source: p.source || "", basis: p.basis, ...(p.m ? {m: p.m} : {})}));
  // Micronutrients only where every part has a database value; fibre is known for all parts. The rest is filled in later.
  const mic = {fiber: t.fiber};
  MICROS.forEach(mc => { if (mc.key !== "fiber" && on.every(p => p.m && p.m[mc.key] != null)) mic[mc.key] = mnum(on.reduce((a, p) => a + partNutrients(p).m[mc.key], 0)); });
  const amt = on.length === 1 ? `${on[0].household ? on[0].household + " · " : ""}${toInput(roundGrams(grams), 1)} g` : `${on.length} items · ${toInput(Math.round(grams), 0)} g`;
  return {id: uid(), name, amt, meal: m.meal, kcal: t.kcal, p: t.p, c: t.c, f: t.f, parts, m: mic,
    base: {name, kcal: t.kcal, p: t.p, c: t.c, f: t.f, unit: "serving", servingLabel: "meal", source: "AI estimate", parts, qty: {amount: 1, unit: "serving"}},
    ai: ai.mode === "edit" ? ai.entry.ai : {confidence: m.confidence, observations: m.observations, assumptions: m.assumptions},
    t: Date.now(), src: ai.mode === "edit" ? ai.entry.src : ai.mode};
}

// ---------- trends ----------
function renderWeek(){
  const keysW = Array.from({length:7}, (_,i) => shift(state.date, i-6));
  const tots = keysW.map(k => totals(entriesFor(k))), vals = tots.map(t => t.kcal);
  const goal = targetsFor(state.date).goal;
  const logged = tots.filter(t => t.kcal > 0);
  const avg = logged.length ? logged.reduce((a,t)=>a+t.kcal,0)/logged.length : 0, pAvg = logged.length ? logged.reduce((a,t)=>a+t.p,0)/logged.length : 0;
  $("weekRange").textContent = `${parseKey(keysW[0]).toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${parseKey(keysW[6]).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;
  $("tiles").innerHTML = `<div class="stat"><b class="num">${logged.length ? fmt(avg) : "–"}</b><span>Avg kcal</span></div><div class="stat"><b class="num">${logged.length ? fmt(pAvg) : "–"}<small> g</small></b><span>Avg protein</span></div><div class="stat"><b class="num">${logged.length}<small> / 7</small></b><span>Days logged</span></div>`;
  const W=360,H=210,L=36,R=4,T=18,B=26, iw=W-L-R, ih=H-T-B;
  const step = Math.max(...vals, goal) > 4000 ? 1000 : 500;
  const max = Math.ceil(Math.max(...vals, goal*1.15)/step)*step;
  const y = v => T + ih - v/max*ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories for the last 7 days">`;
  for (let v=0; v<=max; v+=step) svg += `<line class="gridl" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end" class="num">${v.toLocaleString()}</text>`;
  const slot = iw/7, bw = slot*0.58;
  keysW.forEach((k,i) => {
    const v = vals[i], x = L + slot*i + (slot-bw)/2, sel = k === state.date;
    const h = Math.max(v/max*ih, v>0?2:0);
    svg += `<rect class="b ${v>targetsFor(k).goal?"over":""} ${sel?"sel":""}" data-day="${k}" x="${x}" y="${T+ih-h}" width="${bw}" height="${h}" rx="5"><title>${fmt(v)} kcal</title></rect>`;
    if (v > 0) svg += `<text class="val num" x="${x+bw/2}" y="${T+ih-h-5}" text-anchor="middle">${fmt(v)}</text>`;
    svg += `<text class="dl ${sel?"sel":""}" x="${x+bw/2}" y="${H-8}" text-anchor="middle">${parseKey(k).toLocaleDateString(undefined,{weekday:"narrow"})}</text>`;
  });
  svg += `<line class="goal" x1="${L}" x2="${W-R}" y1="${y(goal)}" y2="${y(goal)}"/>`;
  $("chart").innerHTML = svg + "</svg>";
}
$("chart").addEventListener("click", e => { const b = e.target.closest("[data-day]"); if (b) { state.date = b.dataset.day; show("today"); } });

const imperial = () => state.profile.units === "imperial";
const wFmt = kg => imperial() ? `${toInput(kg / KG_PER_LB, 1)} lb` : `${toInput(kg, 1)} kg`;
function renderWeight(){
  const list = weightList(state.weights), out = $("weightOut");
  if (!list.length) { out.innerHTML = `<div class="card" style="display:grid;gap:12px;text-align:center"><p class="msg">Log your weight now and then to see the trend.</p><button type="button" class="btn tinted" data-wlog>Log weight</button></div>`; return; }
  const last = list[list.length - 1], cut = shift(todayKey(), -30), prev = [...list].reverse().find(x => x.d <= cut) || list[0];
  const diff = last.kg - prev.kg, days = daysBetween(last.d, prev.d);
  const recent = list.filter(x => x.d >= shift(todayKey(), -90));
  let chart = "";
  if (recent.length >= 2) {
    const W = 360, H = 140, L = 34, R = 6, T = 12, B = 22, iw = W - L - R, ih = H - T - B;
    const conv = kg => imperial() ? kg / KG_PER_LB : kg;
    const vs = recent.map(x => conv(x.kg)), lo = Math.floor(Math.min(...vs) - 1), hi = Math.ceil(Math.max(...vs) + 1);
    const t0 = parseKey(recent[0].d).getTime(), t1 = Math.max(parseKey(recent[recent.length - 1].d).getTime(), t0 + 864e5);
    const X = d => L + (parseKey(d).getTime() - t0) / (t1 - t0) * iw, Y = v => T + ih - (v - lo) / (hi - lo) * ih;
    const pts = recent.map((x, i) => `${X(x.d).toFixed(1)},${Y(vs[i]).toFixed(1)}`);
    chart = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over the last 90 days">
      ${[lo, (lo + hi) / 2, hi].map(v => `<line class="gridl" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="num">${toInput(v, 1)}</text>`).join("")}
      <polyline class="wline" points="${pts.join(" ")}"/>${recent.length <= 40 ? recent.map((x, i) => `<circle class="wdot" cx="${X(x.d).toFixed(1)}" cy="${Y(vs[i]).toFixed(1)}" r="3"/>`).join("") : ""}
      <text x="${L}" y="${H - 4}">${parseKey(recent[0].d).toLocaleDateString(undefined, {month: "short", day: "numeric"})}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${parseKey(recent[recent.length - 1].d).toLocaleDateString(undefined, {month: "short", day: "numeric"})}</text></svg></div>`;
  }
  out.innerHTML = `<div class="card" style="display:grid;gap:14px">
      <div class="stats3"><div class="stat"><b class="num">${wFmt(last.kg).replace(/ (kg|lb)$/, "<small> $1</small>")}</b><span>${esc(dayTitle(last.d))}</span></div>
      ${days > 0 ? `<div class="stat"><b class="num">${diff > 0 ? "+" : diff < 0 ? "−" : ""}${wFmt(Math.abs(diff)).replace(/ (kg|lb)$/, "<small> $1</small>")}</b><span>in ${days} ${days === 1 ? "day" : "days"}</span></div>` : ""}</div>
      ${chart}</div>
    <div class="group" style="margin-top:8px">${[...list].reverse().slice(0, 5).map(x => `<button type="button" class="row" data-wedit="${x.d}"><span class="grow">${esc(dayTitle(x.d))}</span><span class="val num strong">${wFmt(x.kg)}</span>${CHEV}</button>`).join("")}</div>`;
}
$("logWeight").addEventListener("click", () => openWeight());
$("weightOut").addEventListener("click", e => { if (e.target.closest("[data-wlog]")) return openWeight(); const r = e.target.closest("[data-wedit]"); if (r) openWeight(r.dataset.wedit); });
let wEditing = null;
function openWeight(d){
  const cur = d && state.weights[d];
  wEditing = cur && cur.kg ? d : null;
  $("wUnit").textContent = imperial() ? "lb" : "kg";
  $("wDate").value = d || (state.date <= todayKey() ? state.date : todayKey()); $("wDate").max = todayKey();
  const last = weightList(state.weights).pop();
  const v = cur && cur.kg ? cur.kg : null;
  $("wVal").value = v ? toInput(imperial() ? v / KG_PER_LB : v, 1) : "";
  $("wVal").placeholder = last ? toInput(imperial() ? last.kg / KG_PER_LB : last.kg, 1) : "";
  clearErr("wVal"); $("wErr").textContent = "";
  $("wDel").hidden = !wEditing; $("wTitle").textContent = wEditing ? "Edit weight" : "Log weight";
  openSheet("weight"); $("wVal").focus();
}
function saveWeight(){
  const r = readAmount($("wVal").value, {required: true, allowZero: false});
  let err = r.error;
  const kg = r.value != null ? (imperial() ? r.value * KG_PER_LB : r.value) : null;
  if (!err && (kg < 20 || kg > 400)) err = imperial() ? "Enter a weight between 44 and 880 lb" : "Enter a weight between 20 and 400 kg";
  const d = $("wDate").value;
  if (!err && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayKey())) err = "Choose a date up to today";
  $("wVal").setAttribute("aria-invalid", err ? "true" : "false"); $("wErr").textContent = err || "";
  if (err) return;
  const now = Date.now();
  if (wEditing && wEditing !== d) state.weights[wEditing] = {kg: null, u: now};
  // Stored to 0.01 kg so a weight typed in pounds converts back to the same number.
  state.weights[d] = {kg: Math.round(kg * 100) / 100, u: now};
  syncProfileWeight(); persist(); closeAll(); render(); toast(`Weight saved · ${wFmt(kg)}`);
}
// The most recent logged weight is the one the targets and coach use.
function syncProfileWeight(){ const last = weightList(state.weights).pop(); if (last && +state.profile.weightKg !== last.kg) { state.profile.weightKg = last.kg; fillProfile(); } }
$("wSave").addEventListener("click", saveWeight);
$("wForm").addEventListener("submit", e => { e.preventDefault(); saveWeight(); });
$("wDel").addEventListener("click", () => {
  const d = wEditing; if (!d) return;
  const old = state.weights[d];
  state.weights[d] = {kg: null, u: Date.now()}; syncProfileWeight(); persist(); closeAll(); render();
  toast("Weight deleted", () => { state.weights[d] = {...old, u: Date.now()}; syncProfileWeight(); persist(); render(); });
});

function renderMicros(){
  const es = entriesFor(state.date), t = microTotals(es), R = microRefs();
  const need = es.filter(e => missingMicros(e).length).length, est = es.filter(e => e.mEst).length;
  $("microDay").textContent = dayTitle(state.date);
  if (!es.length) { $("micros").innerHTML = `<div class="group"><p class="empty">Log food to see fibre, vitamins and minerals.</p></div>`; return; }
  const row = m => {
    const v = t[m.key], ref = R[m.key], pc = ref ? Math.round(v / ref * 100) : null;
    const cls = m.kind === "max" ? (pc > 100 ? "over" : "") : m.kind === "min" ? (pc < 50 ? "lowish" : "") : "";
    return `<div class="mrow ${cls}"><div class="mtop"><b style="font-weight:500">${m.label}</b><span>${mfmt(v, m.unit)}${ref ? ` · ${pc}%` : ""}</span></div>${ref ? `<div class="mini-bar"><i style="width:${Math.min(pc,100)}%"></i></div>` : ""}</div>`;
  };
  let status = "";
  if (enrichBusy) status = `<div class="card">${working("Estimating missing nutrients…")}</div>`;
  else if (need && !hasAI()) status = `<p class="t-foot">${need} ${need===1?"food has":"foods have"} incomplete data. Add a Gemini key to estimate the rest.</p>`;
  else if (need && enrichErr) status = `<div class="card" style="display:grid;gap:8px"><p class="msg err">${esc(enrichErr)}</p><button type="button" class="btn small secondary" id="enrichRetry" style="justify-self:start">Try again</button></div>`;
  else if (need) status = `<button type="button" class="btn small secondary" id="enrichRetry" style="justify-self:start">Estimate missing nutrients</button>`;
  const mins = MICROS.filter(m => m.kind === "min"), main = mins.slice(0, 6), rest = mins.slice(6);
  $("micros").innerHTML = `<div style="display:grid;gap:10px">${status}
    <div class="group">${main.map(row).join("")}<details class="more"><summary>${rest.length} more</summary><div>${rest.map(row).join("")}</div></details></div>
    <div class="section-h" style="margin-top:6px"><span class="t-sub">Limit</span></div>
    <div class="group">${MICROS.filter(m => m.kind !== "min").map(row).join("")}</div>
    <p class="t-foot" style="padding:0 4px">${state.microRefs ? "Targets tailored by AI." : state.profile.sex ? "Targets for your sex and age." : "Standard adult targets."}${est ? ` ${est} of ${es.length} foods include AI estimates.` : ""} Approximate.</p></div>`;
}

// ---------- activity ----------
const WORKOUT_ICONS = [
  [/strength|weight|lift|crossfit|hiit|circuit|core|boxing|calisthenics/i, '<path d="M4 9v6M7 6.5v11M17 6.5v11M20 9v6M7 12h10"/>'],
  [/run|jog|sprint/i, '<circle cx="14.5" cy="4.5" r="1.8"/><path d="M6 20l4-4 1-4.5 4 3 1 5.5M9 9l3-2 3 2 2 3"/>'],
  [/walk|hik/i, '<circle cx="12.5" cy="4.5" r="1.8"/><path d="M9 21l2-6 1-5 3 3 1 8M8 12l4-3"/>'],
  [/cycl|bik|spin/i, '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l2 7"/>'],
  [/swim|surf|row|paddl|kayak/i, '<path d="M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2-1.5 4.5-1.5S19 17 21 17M7 11l4-3 3 3 3-1"/><circle cx="17" cy="6" r="1.6"/>'],
  [/yoga|stretch|pilates|mobility/i, '<circle cx="12" cy="5" r="1.8"/><path d="M12 8v6M5 11l7 1 7-1M8 20l4-6 4 6"/>']
];
const workoutIcon = a => (WORKOUT_ICONS.find(([re]) => re.test(a)) || [0, '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'])[1];
const prettyActivity = a => { const t = String(a || "Workout").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const minsText = m => m >= 60 ? `${Math.floor(m/60)} h ${Math.round(m%60)} min` : `${Math.round(m)} min`;
function distText(m){
  if (!(m > 0)) return "";
  return imperial() ? `${(m/1609.34).toFixed(m < 1609 ? 2 : 1)} mi` : m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}
function renderActivity(){
  const out = $("actOut"), k = state.date, o = state.oura.days[k], isToday = k === todayKey();
  if (!ouraOn() && !Object.keys(state.oura.days).length) {
    out.innerHTML = `<div class="card" style="display:grid;gap:12px;text-align:center"><p class="msg">Connect your Oura ring to see sleep, recovery, calories burned and workouts.</p><button type="button" class="btn tinted" data-go="settings">Connect Oura</button></div>`; return;
  }
  const gen = Date.parse(state.oura.generated), updating = ouraKicked && Date.now() - ouraKicked < 210e3;
  const fresh = updating ? "Updating from Oura…" : gen ? `Oura data updated ${ago(gen)}` : "";
  if (!o) { out.innerHTML = `<div class="card"><p class="msg">${ouraErr ? esc(ouraErr) : `No Oura data for ${esc(dayName(k))} yet. It appears after your ring syncs and the next cloud update.`}</p></div><p class="credit">${esc(fresh)}</p>`; return; }
  const tone = (v, good, bad) => v == null ? "" : v >= good ? "good" : v < bad ? "bad" : "";
  const vital = (v, unit, label, cls) => `<div class="vital ${cls||""}"><b class="num">${v == null ? "–" : v}${v != null && unit ? `<small> ${unit}</small>` : ""}</b><span>${label}</span></div>`;
  let html = `<div class="card"><div class="vitals">
    ${vital(o.readiness_score != null ? fmt(o.readiness_score) : null, "", "Readiness", tone(o.readiness_score, 80, 65))}
    ${vital(o.total_sleep_h != null ? g(o.total_sleep_h) : null, "h", o.sleep_score != null ? `Sleep · ${fmt(o.sleep_score)}` : "Sleep", tone(o.sleep_score, 80, 60))}
    ${vital(o.avg_hrv_ms != null ? fmt(o.avg_hrv_ms) : null, "ms", "HRV")}
    ${vital(o.lowest_hr != null ? fmt(o.lowest_hr) : null, "bpm", "Lowest HR")}
  </div></div>`;
  if (o.steps != null || o.active_kcal != null) html += `<div class="card"><div class="grid2" style="row-gap:16px">
    <div class="stat"><b class="num">${fmt(o.active_kcal || 0)}<small> kcal</small></b><span>Active${o.target_kcal ? ` · ${Math.round((o.active_kcal || 0) / o.target_kcal * 100)}% of goal` : ""}</span></div>
    <div class="stat"><b class="num">${o.total_kcal != null ? fmt(o.total_kcal) : "–"}<small> kcal</small></b><span>Total burn${isToday ? " so far" : ""}</span></div>
    <div class="stat"><b class="num">${o.steps != null ? fmt(o.steps) : "–"}</b><span>Steps${o.walk_m ? ` · ${distText(o.walk_m)}` : ""}</span></div>
    <div class="stat"><b class="num">${o.activity_score != null ? fmt(o.activity_score) : "–"}</b><span>Activity score</span></div></div></div>`;
  const ws = o.workout_list || [];
  html += `<section class="section"><div class="section-h"><h2>Workouts</h2></div><div class="group">` + (ws.length ? ws.map(w => {
      const mins = (new Date(w.end) - new Date(w.start)) / 60000, showDist = w.distance_m > 0 && /run|walk|hik|cycl|bik|swim|row|ski|skat/i.test(w.activity);
      const facts = [mins > 0 ? minsText(mins) : "", w.kcal != null ? `${fmt(w.kcal)} kcal` : "", showDist ? distText(w.distance_m) : "", w.intensity || ""].filter(Boolean).join(" · ");
      return `<div class="row"><svg viewBox="0 0 24 24" style="width:26px;height:26px;stroke:var(--accent);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none">${workoutIcon(w.activity)}</svg><span class="grow"><span class="title">${esc(w.label || prettyActivity(w.activity))}</span><span class="sub">${esc(clock(w.start))}–${esc(clock(w.end))} · ${esc(facts)}</span></span></div>`;
    }).join("") : `<p class="empty">${o.workouts ? esc(o.workouts) : "No workouts recorded."}</p>`) + `</div></section>`;
  // Through the day: one bar per 5 minutes, starting when Oura's day starts (4am)
  if (o.class5 && o.class5_start) {
    const t0 = new Date(o.class5_start), n = o.class5.length, W = 360, H = 96, top = 12, base = 74, bw = W / 288;
    let bars = "";
    for (let i = 0; i < n; i++) { const c = +o.class5[i]; if (c >= 1) { const h = c === 1 ? 3 : (c - 1) * 15; bars += `<rect class="c${c}" x="${(i*bw).toFixed(2)}" y="${base - h}" width="${(bw*0.86).toFixed(2)}" height="${h}" rx="0.5"/>`; } }
    let ticks = "";
    for (let hr = 0; hr < 24; hr += 4) { const d = new Date(t0.getTime() + hr*3600e3); ticks += `<text x="${hr*12*bw + 1}" y="${H - 6}">${d.toLocaleTimeString(undefined,{hour:"numeric"}).replace(/\s/g,"").toLowerCase()}</text>`; }
    const marks = ws.map(w => { const a = (new Date(w.start) - t0) / 300e3 * bw, b = (new Date(w.end) - t0) / 300e3 * bw; return a >= 0 && b <= W + 1 ? `<path class="wk" d="M${a.toFixed(1)} ${top - 6}H${Math.max(b, a + 2).toFixed(1)}"/>` : ""; }).join("");
    html += `<section class="section"><div class="section-h"><h2>Through the day</h2></div><div class="card tl"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity level through the day">${marks}${bars}${ticks}</svg>
      <div class="legend"><span><i style="background:var(--carbs)"></i>High</span><span><i style="background:var(--accent)"></i>Medium</span><span><i style="background:color-mix(in srgb,var(--accent) 55%,var(--fill))"></i>Low</span><span><i style="background:color-mix(in srgb,var(--accent) 25%,var(--fill))"></i>Sitting</span>${ws.length ? `<span>Line = workout</span>` : ""}</div></div></section>`;
  }
  if (o.total_kcal > 0) {
    const eaten = totals(entriesFor(k)).kcal, mx = Math.max(eaten, o.total_kcal), diff = Math.round(eaten - o.total_kcal);
    html += `<section class="section"><div class="section-h"><h2>Energy balance</h2></div><div class="card" style="display:grid;gap:10px">
      <div class="mtop" style="display:flex;justify-content:space-between;font-size:15px"><span>Eaten</span><b class="num">${fmt(eaten)}</b></div><div class="mini-bar" style="height:8px"><i style="width:${mx ? eaten/mx*100 : 0}%;background:var(--accent)"></i></div>
      <div class="mtop" style="display:flex;justify-content:space-between;font-size:15px"><span>Burned</span><b class="num">${fmt(o.total_kcal)}</b></div><div class="mini-bar" style="height:8px"><i style="width:${o.total_kcal/mx*100}%;background:var(--carbs)"></i></div>
      <p class="t-foot">${eaten ? `${fmt(Math.abs(diff))} kcal ${diff < 0 ? "under" : "over"} what you've burned${isToday ? " so far" : ""}.` : "Nothing logged to compare yet."}</p></div></section>`;
  }
  const wk = Array.from({length:7}, (_,i) => shift(k, i-6)), av = wk.map(d => (state.oura.days[d] || {}).active_kcal || 0), sv = wk.map(d => (state.oura.days[d] || {}).steps || 0);
  const mxA = Math.max(...av, 1), W = 360, H = 150, slot = W / 7, bw = slot * 0.56, ih = 92;
  html += `<section class="section"><div class="section-h"><h2>7 days</h2><span class="t-sub">Active kcal · steps</span></div><div class="card chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Active calories and steps for the last 7 days">` +
    wk.map((d,i) => { const h = av[i] / mxA * ih, x = slot*i + (slot - bw)/2, sel = d === k;
      return `<rect class="b ${sel ? "sel" : ""}" data-day="${d}" x="${x}" y="${18 + ih - h}" width="${bw}" height="${Math.max(h, av[i] ? 2 : 0)}" rx="5"/>` +
        (av[i] ? `<text class="val num" x="${x + bw/2}" y="${18 + ih - h - 5}" text-anchor="middle">${fmt(av[i])}</text>` : "") +
        `<text class="dl ${sel ? "sel" : ""}" x="${x + bw/2}" y="${H - 22}" text-anchor="middle">${parseKey(d).toLocaleDateString(undefined,{weekday:"narrow"})}</text>` +
        `<text class="num" x="${x + bw/2}" y="${H - 8}" text-anchor="middle">${sv[i] ? (sv[i] >= 1000 ? (sv[i]/1000).toFixed(1) + "k" : sv[i]) : "–"}</text>`; }).join("") + `</svg></div></section>`;
  html += `<p class="credit">${esc(fresh)}</p>`;
  out.innerHTML = html;
}
$("actOut").addEventListener("click", e => {
  if (e.target.closest("[data-go]")) return show("settings");
  const b = e.target.closest("[data-day]"); if (b) { state.date = b.dataset.day; render(); }
});

// ---------- coach: an AI review of the day's log ----------
// It runs by itself shortly after anything is logged, knows what time it is, and suggests foods the person already eats.
const REVIEW_SCHEMA = {type:"object", additionalProperties:false, required:["score","headline","pace","wins","gaps","next"],
  properties:{
    score:{type:"integer"}, headline:{type:"string"}, pace:{type:"string"},
    wins:{type:"array", items:{type:"string"}},
    gaps:{type:"array", items:{type:"object", additionalProperties:false, required:["name","why","foods"],
      properties:{name:{type:"string"}, why:{type:"string"}, foods:{type:"array", items:{type:"string"}}}}},
    next:{type:"string"}}};
let rvCtl = null, rvError = "", rvTimer = null;
if (state.coach.auto === undefined) state.coach.auto = true;
// What the review depends on. Micronutrient fill-ins and minute-by-minute Oura activity don't count.
const dayStamp = k => { const o = state.oura.days[k] || {};
  return entriesFor(k).map(e => `${e.id}:${e.kcal}`).join("|") + "#" + JSON.stringify(targetsFor(k)) + state.coach.focus + state.coach.about +
    JSON.stringify(state.profile) + JSON.stringify(state.microRefs) + [o.readiness_score, o.sleep_score, (o.workout_list || []).length].join(","); };
const median = a => { const v = [...a].sort((x, y) => x - y), m = v.length >> 1; return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : 0; };
const minsOf = d => d.getHours() * 60 + d.getMinutes();
// Share of a day's calories normally eaten by this time. Uses the person's own last three weeks when there's enough of it.
function usualShareByNow(now){
  const mins = minsOf(now), shares = [], today = keyOf(now);
  for (let i = 1; i <= 21; i++) {
    const es = entriesFor(shift(today, -i)), tot = totals(es).kcal;
    if (es.length < 2 || tot < 800) continue;
    shares.push(es.filter(e => e.t && minsOf(new Date(e.t)) <= mins).reduce((a, e) => a + (+e.kcal || 0), 0) / tot);
  }
  if (shares.length >= 5) return {share: median(shares), source: `their own logging over the last ${shares.length} logged days`};
  const curve = [[0,0],[360,0],[600,.25],[810,.45],[960,.6],[1200,.9],[1320,1],[1440,1]];
  let share = 1;
  for (let i = 1; i < curve.length; i++) if (mins <= curve[i][0]) { const [x0,y0] = curve[i-1], [x1,y1] = curve[i]; share = y0 + (y1 - y0) * (mins - x0) / (x1 - x0); break; }
  return {share, source: "a typical eating day (not enough of their own history yet)"};
}
function personalFoods(){
  const map = new Map(), today = todayKey();
  for (let i = 0; i <= 90; i++) for (const e of entriesFor(shift(today, -i))) {
    const name = ((e.base && e.base.name) || entryTitle(e).title || "").trim(); if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, {name, n: 0, rows: []});
    const r = map.get(key); r.n++; r.rows.push({kcal: +e.kcal || 0, p: +e.p || 0, c: +e.c || 0, f: +e.f || 0, ...(e.m || {})});
  }
  return [...map.values()].map(r => { const usual = {}; ["kcal","p","c","f", ...MICROS.map(m => m.key)].forEach(k => { usual[k] = median(r.rows.map(x => +x[k] || 0)); }); return {name: r.name, n: r.n, usual}; });
}
function topSources(foods, key, unit, n){
  return foods.filter(f => f.usual[key] > 0).sort((a, b) => b.usual[key] * (1 + 0.15 * Math.min(b.n, 6)) - a.usual[key] * (1 + 0.15 * Math.min(a.n, 6))).slice(0, n)
    .map(f => `${f.name} (usual portion ~${Math.round(f.usual.kcal)} kcal gives ${mfmt(f.usual[key], unit)}, logged ${f.n}x)`);
}
// Every logged food is broken down once into plain ingredients, so the coach can suggest ingredients, not one-off dishes.
const foodKey = e => (((e.base && e.base.name) || entryTitle(e).title || "").replace(/\s*·.*$/, "").trim().toLowerCase());
const INGR_SCHEMA = {type:"object", additionalProperties:false, required:["foods"], properties:{foods:{type:"array", items:{type:"object", additionalProperties:false,
  required:["n","kind","ingredients"], properties:{n:{type:"integer"}, kind:{type:"string", enum:["ingredient","product","dish"]},
    ingredients:{type:"array", items:{type:"object", additionalProperties:false, required:["name","grams","kcal","protein_g","carbs_g","fat_g","fiber_g"],
      properties:{name:{type:"string"}, grams:{type:"number"}, kcal:{type:"number"}, protein_g:{type:"number"}, carbs_g:{type:"number"}, fat_g:{type:"number"}, fiber_g:{type:"number"}}}}}}}}};
let ingrBusy = null;
function decomposeFoods(){
  if (!hasAI()) return Promise.resolve();
  if (ingrBusy) return ingrBusy;
  const today = todayKey(), todo = new Map();
  for (let i = 0; i <= 90 && todo.size < 30; i++) for (const e of entriesFor(shift(today, -i))) {
    const key = foodKey(e); if (key && !state.ingr[key] && !todo.has(key)) todo.set(key, e);
    if (todo.size >= 30) break;
  }
  if (!todo.size) return Promise.resolve();
  const list = [...todo.entries()];
  // AI meals already know their parts, so they're described with them.
  const describe = e => e.parts ? `${e.name} (${e.parts.map(p => `${p.grams} g ${p.name}`).join(", ")})` : `${(e.base && e.base.name) || entryTitle(e).title}${entryTitle(e).sub ? ` (${entryTitle(e).sub})` : ""}`;
  ingrBusy = aiJSON(null,
    "Break each logged food below into its main ingredients, for the portion described (calories and macros given are for that portion). " +
    "Name every ingredient with a short generic English name in lower case, the way someone would shop for it (e.g. \"salmon\", \"white rice\", \"broccoli\", \"quark\", \"oats\", \"chicken breast\", \"rye bread\", \"cheese\"), not a brand or dish name. " +
    "Merge minor items (spices, salt, small amounts of sauce) into the closest main ingredient. Give grams and calories, protein, carbohydrate, fat and fibre for each ingredient; together they should add up to the food's totals. " +
    "kind: \"ingredient\" if the food is itself a basic ingredient, \"product\" if it's a packaged product people buy as-is (yoghurt, protein bar, bread), \"dish\" if it's a cooked or composed meal.\n\n" +
    list.map(([key, e], i) => `${i + 1}. ${describe(e)} | ${e.kcal} kcal, protein ${e.p || 0} g, carbs ${e.c || 0} g, fat ${e.f || 0} g`).join("\n"),
    INGR_SCHEMA).then(r => {
      (r.foods || []).forEach(f => { const item = list[(+f.n || 0) - 1]; if (!item) return;
        const [key, e] = item;
        state.ingr[key] = {kind: f.kind, kcal: +e.kcal || 0, items: (f.ingredients || []).slice(0, 12).map(x => ({name: String(x.name || "").toLowerCase().trim().slice(0, 40), g: r1(x.grams), kcal: r1(x.kcal), p: r1(x.protein_g), c: r1(x.carbs_g), f: r1(x.fat_g), fiber: r1(x.fiber_g)})).filter(x => x.name)};
      });
      persist();
    }).catch(() => {}).finally(() => { ingrBusy = null; });
  return ingrBusy;
}
function ingredientStats(){
  const today = todayKey(), map = new Map();
  for (let i = 0; i <= 90; i++) { const d = shift(today, -i);
    for (const e of entriesFor(d)) {
      const dec = state.ingr[foodKey(e)]; if (!dec || !dec.items.length) continue;
      const k = dec.kcal > 0 && e.kcal > 0 ? e.kcal / dec.kcal : 1;
      for (const x of dec.items) {
        if (!map.has(x.name)) map.set(x.name, {name: x.name, days: new Set(), last: null, rows: [], dish: 0});
        const r = map.get(x.name); r.days.add(d); if (!r.last || d > r.last) r.last = d; if (dec.kind === "dish") r.dish++;
        r.rows.push({g: x.g * k, kcal: x.kcal * k, p: x.p * k, c: x.c * k, fiber: x.fiber * k});
      }
    }
  }
  return [...map.values()].map(r => ({name: r.name, days: r.days.size, last: r.last, onlyInDishes: r.dish === r.rows.length,
    g: median(r.rows.map(x => x.g)), kcal: median(r.rows.map(x => x.kcal)), p: median(r.rows.map(x => x.p)), c: median(r.rows.map(x => x.c)), fiber: median(r.rows.map(x => x.fiber))}));
}
const lastEaten = d => { const n = daysBetween(todayKey(), d); return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`; };
function ingredientLines(){
  const all = ingredientStats().filter(x => x.g >= 5);
  if (!all.length) return "";
  const fmtI = x => `${x.name} (typical ${Math.round(x.g)} g: ${Math.round(x.kcal)} kcal, P ${r1(x.p)} g, C ${r1(x.c)} g, fibre ${r1(x.fiber)} g; eaten on ${x.days} ${x.days === 1 ? "day" : "days"}, last ${lastEaten(x.last)}${x.onlyInDishes ? "; so far only as part of dishes" : ""})`;
  const rank = (key, n) => all.filter(x => x[key] > 0).sort((a, b) => (b[key] / Math.max(b.kcal, 40)) * Math.min(b.days, 6) - (a[key] / Math.max(a.kcal, 40)) * Math.min(a.days, 6)).slice(0, n);
  const used = new Set(), pick = (label, key, n) => { const top = rank(key, n); top.forEach(x => used.add(x.name)); return top.length ? `${label}: ${top.map(fmtI).join("; ")}` : ""; };
  const lines = [pick("Best protein sources", "p", 6), pick("Best fibre sources", "fiber", 5), pick("Best carbohydrate sources", "c", 5)];
  const often = all.filter(x => !used.has(x.name)).sort((a, b) => b.days - a.days).slice(0, 12);
  if (often.length) lines.push(`Other ingredients they eat (for vitamins and minerals, use your knowledge of what each contains): ${often.map(fmtI).join("; ")}`);
  return lines.filter(Boolean).join("\n");
}
function reviewPrompt(k){
  const s = targetsFor(k), es = entriesFor(k), t = totals(es), now = new Date(), isToday = k === keyOf(now), R = microRefs(), mt = microTotals(es);
  const lines = MEALS.map(([mk, mn]) => {
    const list = es.filter(e => e.meal === mk);
    return `${mn}: ${list.length ? list.map(e => { const tt = entryTitle(e); return `${tt.title}${tt.sub ? ` [${tt.sub}]` : ""} (${e.kcal} kcal, P ${e.p||0} g, C ${e.c||0} g, F ${e.f||0} g${e.t && isToday ? `, logged ${clock(new Date(e.t).toISOString())}` : ""})`; }).join("; ") : "nothing logged yet"}`;
  }).join("\n");
  const pace = isToday ? usualShareByNow(now) : {share: 1, source: "the full day"};
  const share = Math.max(0.05, pace.share);
  const microLine = MICROS.map(m => { const ref = R[m.key]; if (!ref) return `${m.label} ${mfmt(mt[m.key], m.unit)}`;
    const pct = Math.round(mt[m.key] / ref * 100); return `${m.label} ${mfmt(mt[m.key], m.unit)} = ${pct}% of the ${ref} ${m.unit} daily ${m.kind === "max" ? "limit" : "target"}${isToday && m.kind === "min" ? ` (pace-adjusted: ${Math.round(pct / share)}%)` : ""}`; }).join("; ");
  const foods = personalFoods(), behind = MICROS.filter(m => m.kind === "min" && R[m.key]).map(m => ({m, ratio: mt[m.key] / R[m.key] / share})).sort((a, b) => a.ratio - b.ratio).filter(x => x.ratio < 0.7).slice(0, 4);
  const sourceLists = [["p","Protein","g"],["fiber","Fibre","g"],["c","Carbohydrate","g"], ...behind.map(x => [x.m.key, x.m.label, x.m.unit])]
    .map(([key, label, unit]) => { const top = topSources(foods, key, unit, 5); return top.length ? `${label}: ${top.join("; ")}` : ""; }).filter(Boolean).join("\n");
  const week = Array.from({length: 7}, (_, i) => shift(k, -1 - i)).map(d => ({d, t: totals(entriesFor(d))})).filter(x => x.t.kcal > 0);
  const weekLine = week.length ? `Average over the ${week.length} logged days before this one: ${fmt(week.reduce((a, x) => a + x.t.kcal, 0) / week.length)} kcal, ${fmt(week.reduce((a, x) => a + x.t.p, 0) / week.length)} g protein.` : "";
  const wl = weightList(state.weights), wTrend = wl.length >= 2 ? (() => { const last = wl[wl.length - 1], prev = [...wl].reverse().find(x => x.d <= shift(last.d, -28)) || wl[0]; const d = daysBetween(last.d, prev.d); return d >= 7 ? ` Body weight ${r1(last.kg)} kg on ${last.d}, ${last.kg >= prev.kg ? "+" : ""}${r1(last.kg - prev.kg)} kg over ${d} days.` : ""; })() : "";
  const w = +state.profile.weightKg;
  const ingr = ingredientLines();
  return `You are a sports nutrition coach giving live feedback on one day of a person's food log. Their focus: ${state.coach.focus}.` +
    `\nAbout them: ${profileText()}.${w ? ` Protein so far: ${(t.p / w).toFixed(2)} g per kg body weight; target ${(s.p / w).toFixed(2)} g/kg.` : ""}${wTrend}` +
    (state.coach.about.trim() ? `\nAbout this day, in their words: "${state.coach.about.trim().slice(0, 400)}".` : "") +
    (ouraText(k) ? `\nOura ring data for this day: ${ouraText(k)}.` : "") +
    (weekLine ? `\n${weekLine}` : "") +
    `\n\nDaily targets${state.dayTargets[k] ? " (already adjusted for this day's activity and recovery)" : ""}: ${s.goal} kcal, ${s.p} g protein, ${s.c} g carbohydrate, ${s.f} g fat.` +
    (isToday ? `\nIt is now ${now.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", hour12: false})}. By this time of day they would normally have eaten about ${Math.round(pace.share * 100)}% of the day's calories (based on ${pace.source}), so roughly ${fmt(s.goal * pace.share)} kcal and ${fmt(s.p * pace.share)} g protein would be on pace. Still available today: ${fmt(Math.max(0, s.goal - t.kcal))} kcal, ${fmt(Math.max(0, s.p - t.p))} g protein, ${fmt(Math.max(0, s.c - t.c))} g carbohydrate, ${fmt(Math.max(0, s.f - t.f))} g fat.` : "\nThis day is over.") +
    `\n\nLogged ${isToday ? "so far today" : "that day"}:\n${lines}` +
    `\nTotals: ${Math.round(t.kcal)} kcal, ${r1(t.p)} g protein, ${r1(t.c)} g carbohydrate, ${r1(t.f)} g fat.` +
    `\nMicronutrients (approximate): ${microLine}.` +
    (ingr ? `\n\nIngredients this person has actually eaten in the last 90 days, worked out by breaking down everything they logged:\n${ingr}` :
      sourceLists ? `\n\nFoods this person already eats, best sources first, with their usual portion:\n${sourceLists}` : "") +
    `\n\nRules:` +
    (isToday ? `\n- Judge the day so far against the pace above, not against full-day targets. Being below the daily totals early in the day is expected and must not be called a problem. Only flag calories, protein or a nutrient as low or high if it's clearly off pace or can't realistically be caught up with the meals left today.` : "") +
    `\n- Use the Oura data and their body measurements: adjust for training, burn, sleep and recovery, and scale protein to body weight. Say briefly how today's body data changes the advice when it does.` +
    `\n- Recommend ingredients, not dishes. Pick from the ingredients they've actually eaten (list above), say how much in grams and what it adds, and anchor it to when they had it, e.g. "150 g salmon, like yesterday (+30 g protein)". Combine 1-3 ingredients into something simple they could make, buy or eat at home today. Never tell them to eat a specific school, canteen or restaurant dish again. Only when nothing in their list fits, suggest a common ingredient and mark it "(new idea)".` +
    `\n- Be specific and practical, no generic advice. Micronutrient numbers are estimates, so ignore small differences. No medical advice; only mention supplements if food clearly can't cover a gap.` +
    `\n\nReturn: score (0-100: how well ${isToday ? "the day so far, given the time, supports their focus" : "the day supported their focus"}); headline (one plain sentence, under 14 words); pace (one short sentence on where they stand ${isToday ? "for this time of day" : "for the day"}); wins (1-3 short specific things going well); gaps (0-3 of the most important real issues, most important first, each with a short name, a one-or-two-sentence why tied to performance and their data, and 1-3 foods as described above; leave empty if nothing needs fixing); next (${isToday ? "the best thing to eat at their next meal or snack, with amounts, using their own foods" : "the one change to make tomorrow, using their own foods"}).`;
}
async function runReview(k, auto){
  if (!entriesFor(k).length || !hasAI() || rvCtl) return;
  rvCtl = new AbortController(); rvError = ""; render();
  try {
    enrichErr = ""; clearTimeout(enrichTimer);
    await Promise.all([enrichDay(k), decomposeFoods()]); // micronutrients and ingredient breakdowns first, so the review can use them
    const stamp = dayStamp(k), focus = state.coach.focus;
    const result = await aiJSON(null, reviewPrompt(k), REVIEW_SCHEMA, rvCtl.signal, "text");
    state.reviews[k] = {at: Date.now(), stamp, focus, result, auto: !!auto};
    Object.keys(state.reviews).sort().slice(0, -60).forEach(x => delete state.reviews[x]);   // keep the last 60
    persist();
  } catch (err) {
    rvError = err && err.kind === "cancelled" ? "" : aiErrorCopy(err);
  } finally { rvCtl = null; render(); }
}
// Called after every save: if the viewed day changed in a way that matters, review it again after a short pause.
function scheduleReview(){
  if (!state.coach.auto || !hasAI()) return;
  const k = state.date, today = todayKey();
  if (k !== today && k !== shift(today, -1)) return;
  const rv = state.reviews[k];
  if (!entriesFor(k).length || (rv && rv.stamp === dayStamp(k))) return;
  clearTimeout(rvTimer);
  rvTimer = setTimeout(() => { if (rvCtl) return scheduleReview(); const r = state.reviews[state.date]; if (!r || r.stamp !== dayStamp(state.date)) runReview(state.date, true); }, 12000);
}
const clampScore = s => Math.max(0, Math.min(100, Math.round(+s || 0)));
function scoreRing(sc, small){
  const C = 2*Math.PI*40;
  return `<div class="score ${small ? "sm" : ""} ${sc < 50 ? "low" : sc < 75 ? "mid" : ""}"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="40" fill="none" stroke-width="10"/><circle class="prog" cx="50" cy="50" r="40" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C*(1-sc/100)).toFixed(1)}"/></svg><div class="n num">${sc}</div></div>`;
}
function renderReview(){
  const k = state.date, es = entriesFor(k), rv = state.reviews[k];
  if (document.activeElement !== $("rvFocus")) $("rvFocus").value = state.coach.focus;
  if (document.activeElement !== $("rvAbout")) $("rvAbout").value = state.coach.about;
  $("rvAuto").checked = !!state.coach.auto;
  $("rvGo").disabled = !es.length || !hasAI() || !!rvCtl;
  $("rvGo").textContent = rvCtl ? "Reviewing…" : rv ? "Review again" : "Review now";
  const pending = !rvCtl && rv && rv.stamp !== dayStamp(k);
  const status = rvCtl ? `<div class="card">${working("Reviewing your day…")}</div>` : rvError ? `<div class="notice err">${esc(rvError)}</div>` : pending ? `<p class="t-foot">${state.coach.auto ? "Your log changed. Updating shortly…" : "Your log changed since this review."}</p>` : "";
  let html;
  if (!hasAI()) html = `<div class="card" style="display:grid;gap:12px;text-align:center"><p class="msg">The coach needs a free Gemini key.</p><button type="button" class="btn tinted" data-go-key>Add a key</button></div>`;
  else if (!es.length) html = `<div class="card"><p class="msg">Nothing logged for ${esc(dayName(k))} yet. ${state.coach.auto ? "The coach reviews your day as soon as you log something." : ""}</p></div>`;
  else if (rv) {
    const r = rv.result;
    html = `${status}<div class="card"><div class="rv-head">${scoreRing(clampScore(r.score))}<div><h2>${esc(r.headline || "")}</h2>${r.pace ? `<p class="t-sub" style="margin-top:4px">${esc(r.pace)}</p>` : ""}</div></div></div>` +
      (r.next ? `<section class="section"><div class="section-h"><h2>Eat next</h2></div><div class="card"><p class="msg" style="color:var(--label)">${esc(r.next)}</p></div></section>` : "") +
      ((r.gaps || []).length ? `<section class="section"><div class="section-h"><h2>To improve</h2></div><div class="group">${r.gaps.map(x => `<div class="gap"><b style="font-weight:600">${esc(x.name)}</b><p>${esc(x.why)}</p>${(x.foods||[]).length ? `<div class="chips">${x.foods.slice(0,4).map(f => `<span>${esc(f)}</span>`).join("")}</div>` : ""}</div>`).join("")}</div></section>` : "") +
      ((r.wins || []).length ? `<section class="section"><div class="section-h"><h2>Going well</h2></div><div class="card"><ul class="rv-list">${r.wins.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div></section>` : "") +
      `<p class="t-foot" style="padding:0 4px">For ${esc(rv.focus)} · ${esc(new Date(rv.at).toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"}))}. General guidance, not medical advice.</p>`;
  } else html = status || `<div class="card"><p class="msg">${state.coach.auto ? "The coach will review this day in a moment." : "Tap Review now for feedback."}</p></div>`;
  $("rvOut").innerHTML = html;
}
$("rvOut").addEventListener("click", e => { if (e.target.closest("[data-go-key]")) needKey(); });
$("rvGo").addEventListener("click", () => runReview(state.date, false));
$("rvAuto").addEventListener("change", () => { state.coach.auto = $("rvAuto").checked; persist(); render(); });
$("rvFocus").addEventListener("change", () => { state.coach.focus = $("rvFocus").value; persist(); render(); });
$("rvAbout").addEventListener("change", () => { state.coach.about = $("rvAbout").value; persist(); render(); });

// ---------- settings: Oura ----------
$("ouraForm").addEventListener("submit", e => {
  e.preventDefault();
  const repo = $("ghRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, ""), token = $("ghToken").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { ouraErr = "Enter the repo as owner/name and paste the token."; renderOuraSettings(); return; }
  keys = {...keys, ghRepo: repo, ghToken: token};
  try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys)); } catch {}
  document.activeElement.blur(); remoteLedger = {sha:null, etag:"", data:null}; syncOura(true); syncLedger(true); kickOura(true);
});
$("ouraDisconnect").addEventListener("click", () => {
  keys = {...keys, ghRepo:"", ghToken:""}; try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys)); } catch {}
  state.oura = {fetched:0, generated:"", days:{}}; ouraErr = ""; syncErr = ""; lastSync = 0; persist(); render(); renderOuraSettings(); renderSync(); toast("Disconnected. Your log stays on this device.");
});

// ---------- settings: profile ----------
function fillProfile(){
  const p = state.profile, imp = p.units === "imperial";
  $("pfSex").value = p.sex; $("pfAge").value = p.age ? toInput(+p.age, 0) : ""; $("pfUnits").value = p.units; $("pfActivity").value = p.activity; $("pfNotes").value = p.notes;
  $("pfWeightU").textContent = imp ? "lb" : "kg";
  $("pfWeight").value = +p.weightKg ? toInput(imp ? p.weightKg / KG_PER_LB : +p.weightKg, 1) : "";
  $("pfMetricH").hidden = imp; $("pfImperialH").hidden = !imp;
  $("pfHeight").value = +p.heightCm ? toInput(+p.heightCm, 1) : "";
  const inches = (+p.heightCm || 0) / 2.54;
  $("pfFt").value = inches ? Math.floor(inches / 12) : ""; $("pfIn").value = inches ? toInput(Math.round((inches % 12) * 10) / 10, 1) : "";
  ["pfAge","pfWeight","pfHeight"].forEach(clearErr);
}
// Read the form. Returns false (with errors shown) if anything typed isn't valid; empty fields are allowed.
function readProfile(units = $("pfUnits").value){
  const imp = units === "imperial";
  const age = readField("pfAge", {min: 10, max: 110}), w = readField("pfWeight", imp ? {min: 44, max: 880} : {min: 20, max: 400});
  const h = imp ? null : readField("pfHeight", {min: 100, max: 250});
  const ft = imp ? readAmount($("pfFt").value, {max: 8}) : null, inch = imp ? readAmount($("pfIn").value, {max: 11.99}) : null;
  if (age.error || w.error || (h && h.error) || (ft && ft.error) || (inch && inch.error)) return false;
  const cm = imp ? ((ft.value || 0) * 12 + (inch.value || 0)) * 2.54 : h.value;
  state.profile = {units, sex:$("pfSex").value, age: age.value ? Math.round(age.value) : "", weightKg: w.value ? Math.round((imp ? w.value * KG_PER_LB : w.value) * 100) / 100 : "", heightCm: cm ? Math.round(cm * 10) / 10 : "",
    activity:$("pfActivity").value, notes:$("pfNotes").value};
  return true;
}
// A weight typed here also goes into today's weight log, so the two never disagree.
function logProfileWeight(){
  const kg = +state.profile.weightKg, last = weightList(state.weights).pop();
  if (kg > 0 && (!last || Math.abs(last.kg - kg) >= 0.01)) state.weights[todayKey()] = {kg, u: Date.now()};
}
$("pfUnits").addEventListener("change", () => {
  // Keep what's typed: read it in the old units, then redisplay in the new ones.
  const next = $("pfUnits").value;
  if (readProfile(state.profile.units)) { state.profile.units = next; fillProfile(); } else $("pfUnits").value = state.profile.units;
});
$("profileForm").addEventListener("submit", e => {
  e.preventDefault(); if (!readProfile()) return;
  logProfileWeight(); persist(); document.activeElement.blur(); render(); toast("Saved");
});
const PLAN_SCHEMA = {type:"object", additionalProperties:false, required:["kcal","protein_g","carbs_g","fat_g","summary", ...MICRO_REQ],
  properties:{kcal:{type:"number"}, protein_g:{type:"number"}, carbs_g:{type:"number"}, fat_g:{type:"number"}, summary:{type:"string"}, ...MICRO_PROPS}};
let planBusy = false, planErr = "";
function renderPlan(){
  const pl = state.plan;
  let html = "";
  if (planBusy) html = working("Working out your targets…");
  else if (planErr) html = `<p class="msg err">${esc(planErr)}</p>`;
  if (pl && !planBusy) {
    const s = state.settings, applied = s.goal === pl.kcal && s.p === pl.p && s.c === pl.c && s.f === pl.f;
    html += `<div class="card" style="background:var(--accent-soft);display:grid;gap:8px"><p class="t-head num">${fmt(pl.kcal)} kcal · P ${fmt(pl.p)} · C ${fmt(pl.c)} · F ${fmt(pl.f)} g</p>
      <p class="msg">${esc(pl.summary || "")}</p>
      <div class="btn-row">${applied ? `<span class="msg ok">These are your current targets.</span>` : `<button type="button" class="btn small" id="planApply">Use these</button>`}
      ${state.microRefs ? `<button type="button" class="btn small secondary" id="planReset">Standard vitamin targets</button>` : ""}</div></div>`;
  }
  $("pfOut").innerHTML = html;
}
$("pfCalc").addEventListener("click", async () => {
  if (!readProfile()) { $("profileForm").scrollIntoView({block: "center"}); return; }
  logProfileWeight(); persist();
  const base = formulaPlan();
  if (!base) { planErr = "Add your sex, age, height and weight under About you first."; renderPlan(); return; }
  planErr = "";
  const focus = state.coach.focus;
  if (!hasAI()) {
    state.plan = {...base, ai:false, summary:`${base.burn ? `From the ${fmt(base.burn)} kcal a day your Oura ring measured` : "From your size, age and activity"}, for ${focus}.`};
    persist(); renderPlan(); return;
  }
  planBusy = true; renderPlan();
  try {
    const std = driRefs();
    const r = await aiJSON(null,
      `You are a sports dietitian setting daily nutrition targets for one person. About them: ${profileText()}. Their focus: ${focus}.` +
      `\n${base.burn ? `Their Oura ring measured an average total burn of ${base.burn} kcal a day over the last two weeks. Starting from that,` : "A standard formula (Mifflin-St Jeor with an activity factor)"} gives: ${base.kcal} kcal, ${base.p} g protein, ${base.c} g carbohydrate, ${base.f} g fat.` +
      `\nStandard reference intakes for their sex and age: ${MICROS.filter(m => std[m.key]).map(m => `${m.ai}=${std[m.key]}`).join(", ")}.` +
      `\nReturn daily targets tailored to this person: calories and macros (macros must add up to the calories), and a target for each micronutrient in the units named by the field (treat sodium and saturated fat as upper limits; set sugars_g to 0). ` +
      `Stay close to the standard values unless their size, activity, diet or focus gives a clear evidence-based reason to differ. Never exceed established safe upper limits. ` +
      `In summary, explain in two plain sentences what you changed from the standard values and why.`, PLAN_SCHEMA, undefined, "text");
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, +v || lo));
    const refs = {};
    MICROS.forEach(m => { if (std[m.key]) { const v = clamp(r[m.ai], std[m.key]*0.6, std[m.key]*2.5); refs[m.key] = v >= 100 ? Math.round(v/10)*10 : v >= 10 ? Math.round(v) : Math.round(v*10)/10; } });
    state.microRefs = refs;
    state.plan = {kcal:Math.round(clamp(r.kcal, base.kcal*0.7, base.kcal*1.4)/10)*10, p:Math.round(clamp(r.protein_g, 30, 400)), c:Math.round(clamp(r.carbs_g, 20, 900)), f:Math.round(clamp(r.fat_g, 20, 300)), ai:true, summary:String(r.summary || "").slice(0, 600)};
    persist();
  } catch (err) {
    planErr = aiErrorCopy(err) + " Showing the standard estimate.";
    state.plan = {...base, ai:false, summary:`From your size, age and activity, for ${focus}.`};
    persist();
  } finally { planBusy = false; renderPlan(); }
});
$("pfOut").addEventListener("click", e => {
  if (e.target.id === "planApply" && state.plan) {
    const pl = state.plan; state.settings = {goal:pl.kcal, p:pl.p, c:pl.c, f:pl.f};
    persist(); fillTargets(); render(); renderPlan(); toast("Daily targets updated");
  }
  if (e.target.id === "planReset") { state.microRefs = null; persist(); render(); renderPlan(); toast("Vitamin and mineral targets reset"); }
});

// ---------- settings: targets ----------
function fillTargets(){
  const s = state.settings;
  $("tGoal").value = toInput(s.goal, 0); $("tP").value = toInput(s.p, 0); $("tC").value = toInput(s.c, 0); $("tF").value = toInput(s.f, 0);
  ["tGoal","tP","tC","tF"].forEach(clearErr); $("tMacroErr").textContent = "";
}
$("targetForm").addEventListener("submit", e => {
  e.preventDefault();
  const goal = readField("tGoal", {required: true, min: 800, max: 8000});
  const [p, c, f] = ["tP","tC","tF"].map(id => readField(id, {max: 1000}));
  if (goal.error || p.error || c.error || f.error) { $("tMacroErr").textContent = [p, c, f].some(x => x.error) ? "Macros must be numbers from 0 to 1000 g." : ""; return; }
  state.settings = {goal: Math.round(goal.value), p: Math.round(p.value || 0), c: Math.round(c.value || 0), f: Math.round(f.value || 0)};
  const est = state.settings.p * 4 + state.settings.c * 4 + state.settings.f * 9;
  $("tMacroErr").textContent = est && Math.abs(est - state.settings.goal) > state.settings.goal * 0.15 ? `Saved. Note: these macros add up to ${fmt(est)} kcal.` : "";
  persist(); document.activeElement.blur(); render(); renderPlan(); toast("Targets saved");
});

// ---------- settings: keys ----------
function renderKeys(){
  $("kGemini").value = keys.gemini; $("kAnthropic").value = keys.anthropic; $("kUsda").value = keys.usda;
  $("kState").textContent = keys.anthropic ? "Using Claude for AI estimates." : keys.gemini ? "Using Gemini for AI estimates." : "No key yet. Photo and description estimates are off.";
}
function saveKeys(){ try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys)); } catch {} renderKeys(); render(); }
$("keyForm").addEventListener("submit", e => {
  e.preventDefault();
  keys = {...keys, gemini:$("kGemini").value.trim(), anthropic:$("kAnthropic").value.trim(), usda:$("kUsda").value.trim()};
  saveKeys(); document.activeElement.blur(); toast("Keys saved on this device");
});
$("clearKeys").addEventListener("click", () => { keys = {...keys, gemini:"", anthropic:"", usda:""}; saveKeys(); toast("Keys removed from this device"); });
// Ask each model a tiny question and show what comes back.
$("aiTest").addEventListener("click", async () => {
  const out = $("aiTestOut"), key = $("kGemini").value.trim();
  if (key && key !== keys.gemini) { keys = {...keys, gemini: key}; saveKeys(); }
  if (!keys.gemini) { out.innerHTML = `<p class="msg err">Paste your Gemini key first.</p>`; return; }
  $("aiTest").disabled = true; out.innerHTML = working("Testing each Gemini model…");
  const body = {contents: [{role: "user", parts: [{text: 'Reply with the JSON {"ok": true}.'}]}], generationConfig: {responseMimeType: "application/json", responseSchema: {type:"object", properties:{ok:{type:"boolean"}}, required:["ok"]}}};
  const rows = []; let best = null;
  for (const model of FAST_MODELS) {
    const r = await geminiCall(keys.gemini, model, body, null, 25000);
    const secs = (r.ms / 1000).toFixed(1);
    if (r.ok) { rows.push(`<p class="msg ok">${model}: working (${secs} s)</p>`); if (!best || r.ms < best.ms) best = {model, ms: r.ms}; }
    else rows.push(`<p class="msg err">${model}: ${r.status === 429 ? "free limit reached" : r.status === 404 ? "not available to your key" : r.status === 408 ? "too slow" : r.status >= 500 ? "overloaded" : r.status === 0 ? "couldn't connect" : "rejected"} (${r.status || "no response"})</p>`);
    if (/API key not valid/i.test(r.detail)) break;
  }
  if (best) setFastest(best.model);
  else rows.push(`<p class="msg">No model answered. If every line says the free limit is reached, it resets daily.</p>`);
  out.innerHTML = rows.join(""); $("aiTest").disabled = false;
});
function renderDiag(){
  $("diagOut").innerHTML = diag.length ? `<div class="facts">${diag.slice(0, 15).map(d => `<div><span>${esc(new Date(d.at).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}))} · ${esc(d.task || "")}</span><span>${esc(d.model || "")} ${d.ok ? "ok" : esc(d.kind || "failed") + (d.status ? " " + d.status : "")}${d.ms ? ` · ${(d.ms / 1000).toFixed(1)} s` : ""}</span></div>`).join("")}</div>` : `<p class="msg">No AI requests yet.</p>`;
}

// ---------- settings: data ----------
function renderDataInfo(){
  const days = Object.keys(state.days).filter(k => entriesFor(k).length);
  const n = days.reduce((a,k) => a + entriesFor(k).length, 0), w = weightList(state.weights).length;
  $("dataInfo").textContent = `${n.toLocaleString()} ${n===1?"entry":"entries"} over ${days.length} ${days.length===1?"day":"days"}, ${w} weight ${w === 1 ? "entry" : "entries"}. ${keys.ghRepo && keys.ghToken && !syncErr ? "Synced through your private repo." : "Stored on this device only, so export a backup now and then."}`;
}
$("exportBtn").addEventListener("click", async () => {
  const blob = new Blob([JSON.stringify({app:"calorie-ledger", version:2, exported:new Date().toISOString(), settings:state.settings, days:state.days, weights:state.weights, barcodes:state.barcodes, coach:state.coach, reviews:state.reviews, profile:state.profile, microRefs:state.microRefs, plan:state.plan, dayTargets:state.dayTargets}, null, 1)], {type:"application/json"});
  const name = `calorie-ledger-${todayKey()}.json`;
  const file = new File([blob], name, {type:"application/json"});
  if (navigator.canShare && navigator.canShare({files:[file]})) {
    try { await navigator.share({files:[file], title:"Calorie Ledger backup"}); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (!o || typeof o.days !== "object") throw 0;
    let added = 0;
    for (const [k, list] of Object.entries(o.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Array.isArray(list)) continue;
      const have = new Set(entriesFor(k).map(x => x.id));
      const fresh = list.filter(x => x && x.id && !have.has(x.id) && Number.isFinite(+x.kcal));
      if (fresh.length) { state.days[k] = [...entriesFor(k), ...fresh]; added += fresh.length; }
    }
    if (o.weights) Object.entries(o.weights).forEach(([d, v]) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v && !state.weights[d]) state.weights[d] = v; });
    if (o.settings) state.settings = {...DEFAULTS, ...o.settings};
    if (o.barcodes) state.barcodes = {...o.barcodes, ...state.barcodes};
    if (o.reviews) state.reviews = {...o.reviews, ...state.reviews};
    if (o.coach) state.coach = {...state.coach, ...o.coach};
    if (o.profile) { state.profile = {...state.profile, ...o.profile}; fillProfile(); }
    if (o.microRefs) state.microRefs = o.microRefs;
    persist(); fillTargets(); render();
    $("dataMsg").className = "msg ok"; $("dataMsg").textContent = `Imported ${added} ${added===1?"entry":"entries"}. Entries you already had were kept.`;
  } catch {
    $("dataMsg").className = "msg err"; $("dataMsg").textContent = "That file isn't a Calorie Ledger backup.";
  }
});

// ---------- toast ----------
let toastTimer, undoFn;
function toast(msg, undo){
  $("toastMsg").textContent = msg; undoFn = undo; $("toastUndo").hidden = !undo;
  $("toast").classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 4500);
}
$("toastUndo").addEventListener("click", () => { if (undoFn) undoFn(); undoFn = null; $("toast").classList.remove("show"); });

// ---------- start ----------
state.meal = defaultMeal();
fillTargets(); fillProfile(); renderKeys(); renderOuraSettings(); renderPlan();
show(location.hash.slice(1) || "today");
if (ouraOn()) { syncOura(); if (ouraStale()) kickOura(); } syncLedger(); renderSync();
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
loadSwedishFoods();
// Exposed for the automated tests in tests/ (read-only use).
window.__ledger = {state, render, show};
