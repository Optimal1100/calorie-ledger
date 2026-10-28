// AI client: Google Gemini (free tier) by default, Claude when an Anthropic key is set.
// Keys come from the caller and are sent only to their own provider. Images are resized in the browser and never stored.

// Photo and label work goes to the most capable free Flash model first, with time to reason; quick text jobs
// (micronutrient fill-ins, ingredient breakdowns, reviews) start with whichever model answered fastest last time.
export const FAST_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.7-flash"];
export const QUALITY_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const TASKS = {
  // thinking: Gemini thinking level; hedge: ms before also asking the next model; timeout per model; side: longest image side sent
  meal:  {models: QUALITY_MODELS, thinking: "medium", hedge: 30000, timeout: 75000, side: 1536, hires: true},
  text:  {models: QUALITY_MODELS, thinking: "low", hedge: 20000, timeout: 45000},
  label: {models: QUALITY_MODELS, thinking: "low", hedge: 20000, timeout: 60000, side: 1600, hires: true},
  fast:  {models: FAST_MODELS, thinking: "minimal", hedge: 4000, timeout: 30000, preferFastest: true, side: 1280}
};
const AI_MODEL = "claude-opus-5-5";
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm";
const MODEL_KEY = "calorie-ledger-model";
let fastest = ""; try { fastest = localStorage.getItem(MODEL_KEY) || ""; } catch {}
export const setFastest = m => { fastest = m; try { localStorage.setItem(MODEL_KEY, m); } catch {} };

export function loadImage(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej({kind: "image"}); };
    img.src = url;
  });
}
// Downscale (never upscale) to a JPEG. Browsers apply the photo's EXIF rotation when drawing.
export async function toJpegBase64(file, maxSide, quality = 0.88){
  const img = await loadImage(file);
  const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", quality));
  if (!blob) throw {kind: "image"};
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Gemini's responseSchema is an OpenAPI subset: no additionalProperties. propertyOrdering makes the model write
// its observations before its numbers.
export function geminiSchema(x){
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== "object") return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) if (k !== "additionalProperties") out[k] = geminiSchema(v);
  if (x.type === "object" && x.properties) out.propertyOrdering = Object.keys(x.properties);
  return out;
}

// One request to one model, given up on after timeoutMs. Never throws except when the caller cancels.
export async function geminiCall(key, model, body, signal, timeoutMs){
  const ctl = new AbortController(), t0 = Date.now(); let timedOut = false;
  const onAbort = () => ctl.abort(); if (signal) signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: ctl.signal, headers: {"content-type": "application/json", "x-goog-api-key": key}, body: JSON.stringify(body)});
    const data = await res.json().catch(() => null);
    return {ok: res.ok, status: res.status, data, detail: String((data && data.error && data.error.message) || "").slice(0, 160), ms: Date.now() - t0};
  } catch {
    if (signal && signal.aborted) throw {kind: "cancelled"};
    return {ok: false, status: timedOut ? 408 : 0, data: null, detail: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : "network error", ms: Date.now() - t0};
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
}

// One model, one answer: {value} on success or {err, fatal}.
async function geminiTry(key, model, parts, config, extra, signal, timeout){
  const body = cfg => ({contents: [{role: "user", parts}], generationConfig: cfg});
  let r = await geminiCall(key, model, body({...config, ...extra}), signal, timeout);
  // An older model may reject the thinking or resolution settings; ask again without them.
  if (r.status === 400 && !/API key/i.test(r.detail)) r = await geminiCall(key, model, body(config), signal, timeout);
  if (!r.ok) {
    const err = {kind: "gemini", status: r.status, model, detail: r.detail, badKey: /API key not valid|API_KEY_INVALID/i.test(r.detail), ms: r.ms};
    return {err, fatal: err.badKey || r.status === 401};
  }
  const cand = ((r.data && r.data.candidates) || [])[0];
  const blocked = !cand || (r.data.promptFeedback && r.data.promptFeedback.blockReason) || /SAFETY|PROHIBITED|BLOCK/.test(cand.finishReason || "");
  const text = cand ? ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("") : "";
  try { if (!blocked) return {value: JSON.parse(text), model, ms: r.ms}; } catch {}
  return {err: blocked ? {kind: "refused", model, ms: r.ms} : {kind: cand && cand.finishReason === "MAX_TOKENS" ? "truncated" : "badjson", model, ms: r.ms}};
}

async function geminiJSON(file, prompt, schema, {signal, task = "fast", keys, note = () => {}, log = () => {}}){
  const T = TASKS[task] || TASKS.fast;
  const parts = file ? [{inline_data: {mime_type: "image/jpeg", data: await toJpegBase64(file, T.side || 1280)}}, {text: prompt}] : [{text: prompt}];
  const config = {responseMimeType: "application/json", responseSchema: geminiSchema(schema), temperature: 0.2};
  const extra = {thinkingConfig: {thinkingLevel: T.thinking}, ...(file && T.hires ? {mediaResolution: "MEDIA_RESOLUTION_HIGH"} : {})};
  const order = T.preferFastest ? [...new Set([fastest, ...T.models].filter(Boolean))] : T.models;
  // Ask the first model. If it hasn't answered after the hedge delay, ask the next one too and take whichever answers first.
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false, last = {kind: "gemini", status: 0}, hedge = null;
    const ctls = [];
    const finish = (ok, v) => { if (done) return; done = true; clearTimeout(hedge); ctls.forEach(c => c.abort()); note(""); (ok ? resolve : reject)(v); };
    if (signal) { if (signal.aborted) return finish(false, {kind: "cancelled"}); signal.addEventListener("abort", () => finish(false, {kind: "cancelled"})); }
    const launch = () => {
      if (done || next >= order.length) return;
      const model = order[next++], ctl = new AbortController(); ctls.push(ctl); running++;
      note(running > 1 ? "Still working, asking a second model too…" : "");
      geminiTry(keys.gemini, model, parts, config, extra, ctl.signal, T.timeout).catch(() => ({err: {kind: "cancelled"}})).then(r => {
        running--;
        if (done) return;
        if (r.value !== undefined) {
          log({task, model, ms: r.ms, ok: true});
          if (T.preferFastest && fastest !== model) setFastest(model);
          return finish(true, r.value);
        }
        if (r.err.kind !== "cancelled") { last = r.err; log({task, model, ms: r.err.ms, ok: false, kind: r.err.kind, status: r.err.status}); }
        if (r.fatal) return finish(false, r.err);
        if (r.err.status === 0 && navigator.onLine === false) return finish(false, {kind: "offline"});
        if (next < order.length) { clearTimeout(hedge); launch(); }
        else if (!running) finish(false, last);
      });
      clearTimeout(hedge);
      hedge = setTimeout(() => { if (!done && next < order.length) launch(); }, T.hedge);
    };
    launch();
  });
}

let AnthropicSDK = null;
async function claudeJSON(file, prompt, schema, {signal, task = "fast", keys, log = () => {}}){
  const content = [{type: "text", text: prompt}];
  if (file) content.unshift({type: "image", source: {type: "base64", media_type: "image/jpeg", data: await toJpegBase64(file, 1568)}});
  if (!AnthropicSDK) {
    try { AnthropicSDK = (await import(SDK_URL)).default; } catch { throw {kind: "offline"}; }
  }
  const client = new AnthropicSDK({apiKey: keys.anthropic, dangerouslyAllowBrowser: true});
  const t0 = Date.now();
  let res;
  try {
    res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {effort: task === "fast" ? "low" : "medium", format: {type: "json_schema", schema}},
      messages: [{role: "user", content}]
    }, {signal});
  } catch (e) {
    if (signal && signal.aborted) throw {kind: "cancelled"};
    log({task, model: AI_MODEL, ms: Date.now() - t0, ok: false, kind: "api", status: e && e.status});
    throw {kind: "api", status: e && e.status};
  }
  log({task, model: res.model || AI_MODEL, ms: Date.now() - t0, ok: res.stop_reason !== "refusal" && res.stop_reason !== "max_tokens", kind: res.stop_reason});
  if (res.stop_reason === "refusal") throw {kind: "refused"};
  if (res.stop_reason === "max_tokens") throw {kind: "truncated"};
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { return JSON.parse(text); } catch { throw {kind: "badjson"}; }
}

// `file` is an image to look at, or null for a text-only request.
export function aiJSON(file, prompt, schema, opts){
  if (opts.keys.anthropic) return claudeJSON(file, prompt, schema, opts);
  if (opts.keys.gemini) return geminiJSON(file, prompt, schema, opts);
  return Promise.reject({kind: "nokey"});
}

export function aiErrorCopy(e){
  switch (e && e.kind) {
    case "nokey": return "Add a free Gemini key in Settings to use this.";
    case "image": return "Couldn't open that image. Try a JPEG or PNG photo.";
    case "gemini": {
      const why = e.detail ? ` (Google said: ${e.detail})` : "";
      if (e.badKey || e.status === 401 || e.status === 403) return "Your Gemini key was rejected. Check it in Settings." + why;
      if (e.status === 429) return "Gemini's free limit is used up for now. Wait a minute and try again; the daily allowance resets tomorrow.";
      if (e.status === 404) return "None of the Gemini models this app uses are available to your key." + why;
      if (e.status >= 500) return "Gemini is overloaded right now. Try again in a few minutes.";
      if (e.status === 408) return "Gemini took too long to answer. Try again in a moment.";
      if (e.status === 400) return "Gemini couldn't process that request." + why;
      return "Couldn't reach Gemini. Check your connection and try again.";
    }
    case "offline": return "You're offline. Estimates need an internet connection.";
    case "refused": return "The AI declined that request. Try a different photo or description.";
    case "truncated": case "badjson": return "The AI's answer was incomplete. Try again.";
    case "api":
      if (e.status === 401) return "Your Anthropic key was rejected. Check it in Settings.";
      if (e.status === 403) return "Your Anthropic key doesn't have access to this model.";
      if (e.status === 429) return "Too many requests right now. Wait a minute and try again.";
      if (e.status === 400) return "Anthropic couldn't process that request. If your account is out of credits, add some at console.anthropic.com.";
      if (e.status >= 500) return "Anthropic's service had a problem. Try again in a moment.";
      return "Couldn't reach Anthropic. Check your connection and try again.";
    default: return "Something went wrong. Try again.";
  }
}
