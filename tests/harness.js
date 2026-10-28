// A tiny test runner for the browser: test(name, fn), assertions, and a results table.
const tests = [];
export const test = (name, fn) => tests.push({name, fn});
export class AssertionError extends Error {}
export function eq(actual, expected, msg = ""){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
}
export function ok(v, msg = "expected true"){ if (!v) throw new AssertionError(msg); }
export function near(actual, expected, tol, msg = ""){
  if (!(Math.abs(actual - expected) <= tol)) throw new AssertionError(`${msg ? msg + ": " : ""}expected ${expected} ±${tol}, got ${actual}`);
}
export async function run(title){
  const out = document.getElementById("out"), results = [];
  document.title = title + " (running)";
  for (const t of tests) {
    const t0 = performance.now();
    try { await t.fn(); results.push({name: t.name, pass: true, ms: performance.now() - t0}); }
    catch (e) { results.push({name: t.name, pass: false, err: e && e.message || String(e), ms: performance.now() - t0}); console.error(t.name, e); }
    render();
  }
  function render(){
    const pass = results.filter(r => r.pass).length;
    out.innerHTML = `<h2>${pass} / ${tests.length} passed${results.length < tests.length ? " (running…)" : ""}</h2>` +
      results.map(r => `<div class="${r.pass ? "p" : "f"}">${r.pass ? "✓" : "✗"} ${r.name} <small>${r.ms.toFixed(0)} ms</small>${r.err ? `<pre>${r.err.replace(/</g, "&lt;")}</pre>` : ""}</div>`).join("");
  }
  const failed = results.filter(r => !r.pass).length;
  document.title = `${title}: ${failed ? failed + " failed" : "all passed"}`;
  window.__results = {total: tests.length, passed: tests.length - failed, failed, results};
  return window.__results;
}
