import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

// Exercise the rendered script with user events and deferred server responses.
export async function testPreferencesInteraction(html) {
  function element(value = "") {
    const listeners = new Map();
    const label = { hidden: false, classList: { toggle() {} } };
    return { value, textContent: "", className: "", disabled: false, checked: true,
      addEventListener: (name, fn) => listeners.set(name, fn),
      fire: name => listeners.get(name)?.(), closest: () => label, label,
    };
  }
  const category = { ...element(), name: "registration" };
  const audience = { ...element(), dataset: { aud: "student" } };
  const contest = element("电子设计竞赛");
  const otherContest = element("数学建模竞赛");
  otherContest.checked = false;
  const controls = Object.fromEntries(["msg", "applybar", "applytext", "applyNow", "frequency", "pausedUntil", "contest-search", "contest-search-state"].map(id => [id, element()]));
  controls.frequency.value = "instant";
  controls.settings = {
    getAttribute: name => name === "data-email" ? "test@domain.net" : "300000",
    addEventListener() {},
    querySelectorAll: selector => selector.includes("#opts") ? [category] : selector.includes("#aud-opts") ? [audience] : [contest, otherContest],
  };
  const requests = [];
  const pending = [];
  const memory = new Map();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n");
  assert.ok(script.includes("/api/prefs"));
  runInNewContext(script, {
    document: { addEventListener() {}, getElementById: id => controls[id] ?? null, querySelectorAll: () => [] },
    window: { addEventListener() {} }, navigator: {},
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
    setTimeout: () => 1, clearTimeout() {},
    fetch: (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return new Promise(resolve => pending.push(() => resolve({ json: async () => ({ ok: true }) }))); },
  });
  controls["contest-search"].value = "电子";
  controls["contest-search"].fire("input");
  assert.equal(contest.label.hidden, false);
  assert.equal(otherContest.label.hidden, true);
  assert.equal(contest.checked, true);
  assert.equal(otherContest.checked, false);
  assert.equal(memory.size, 0, "search alone must not stage preference changes");

  controls.frequency.value = "daily";
  controls.frequency.fire("change");
  controls.applyNow.fire("click");
  assert.equal(requests.length, 1);
  assert.equal(controls.applyNow.disabled, true);
  controls.frequency.value = "weekly";
  controls.frequency.fire("change");
  controls.applyNow.fire("click");
  assert.equal(requests.length, 1, "saving must prevent duplicate requests");
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controls.applybar.className, "applybar on");
  assert.match(controls.applytext.textContent, /新的修改等待保存/);
  assert.equal(memory.size, 1, "the newer edit must remain staged");
  controls.applyNow.fire("click");
  assert.equal(requests[1].body.frequency, "weekly");
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controls.applybar.className, "applybar");
  assert.equal(memory.size, 0);
}
