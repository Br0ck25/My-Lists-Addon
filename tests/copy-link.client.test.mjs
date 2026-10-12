// Copying the install link (copyLink, 24_client-backup-restore-presets.js).
//
// It is the core action of the page. It called navigator.clipboard.writeText
// with no guard, so where there is no clipboard API (a page served over http,
// some in-app webviews) it threw before its own fallback could run and the
// click did nothing. It now goes through copyTextToClipboard, which falls back
// to selecting a hidden textarea and execCommand('copy'), and only when both
// fail does it show the link for copying by hand.
//
// The Nuvio buttons copy the same link and used to say "Manifest link copied"
// whether or not it had been; they now say it only when it was.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const URL_ = "https://example.com/cfg123/manifest.json";

function setup({ clipboard = "absent", execCommand = "works" } = {}) {
  const c = loadClient();
  const nav = c.get("window").navigator;
  if (clipboard === "absent") delete nav.clipboard;
  else if (clipboard === "rejects") nav.clipboard = { writeText: async () => { throw new Error("NotAllowedError"); } };
  else nav.clipboard = { writeText: async (t) => { copied.api = t; } };

  const copied = { api: null, exec: null };
  const doc = c.get("document");
  const made = [];
  const baseCreate = doc.createElement;
  doc.createElement = (...a) => { const el = baseCreate(...a); made.push(el); return el; };
  doc.execCommand = (cmd) => {
    if (cmd !== "copy" || execCommand !== "works") return false;
    const box = made.find((el) => el.value === URL_);
    copied.exec = box ? box.value : null;
    return !!box;
  };

  const toasts = [];
  c.set("showToast", (message, type) => { toasts.push({ message, type }); return { dismiss() {} }; });
  c.set("showAddedToast", (message) => { toasts.push({ message, type: "success" }); });
  return { c, copied, toasts };
}

describe("copyLink", () => {
  it("copies through the clipboard API and marks the button copied", async () => {
    const { c, copied } = setup({ clipboard: "works" });
    const btn = c.get("document").getElementById("copyUrlBtn");
    btn.innerHTML = "Copy";
    await c.call("copyLink", URL_);
    assert.equal(copied.api, URL_);
    assert.match(btn.innerHTML, /Copied!/);
  });

  it("with no clipboard API it still copies, by the textarea fallback, and does not throw", async () => {
    const { c, copied, toasts } = setup({ clipboard: "absent" });
    const btn = c.get("document").getElementById("copyUrlBtn");
    btn.innerHTML = "Copy";
    await assert.doesNotReject(async () => c.call("copyLink", URL_));
    assert.equal(copied.exec, URL_, "the link reached the fallback copy");
    assert.match(btn.innerHTML, /Copied!/);
    assert.ok(!toasts.some((t) => t.type === "error"), "no failure is reported: " + JSON.stringify(toasts));
  });

  it("when the clipboard refuses, the fallback copies it", async () => {
    const { c, copied } = setup({ clipboard: "rejects" });
    await c.call("copyLink", URL_);
    assert.equal(copied.exec, URL_);
  });

  it("when nothing can copy, the link is shown so it can be copied by hand", async () => {
    const { c, toasts } = setup({ clipboard: "absent", execCommand: "fails" });
    await assert.doesNotReject(async () => c.call("copyLink", URL_));
    assert.ok(toasts.some((t) => t.type === "error" && t.message.includes(URL_)), JSON.stringify(toasts));
  });
});

describe("the Nuvio buttons only say the link was copied when it was", () => {
  for (const fn of ["copyNuvioInstallLink", "openNuvioWeb"]) {
    it(fn + ": says copied when it copied", async () => {
      const { c, toasts } = setup({ clipboard: "works" });
      c.get("window").open = () => {};
      await c.call(fn, URL_);
      assert.ok(toasts.some((t) => /copied to clipboard/i.test(t.message)), JSON.stringify(toasts));
    });

    it(fn + ": does not say copied when nothing could copy", async () => {
      const { c, toasts } = setup({ clipboard: "absent", execCommand: "fails" });
      c.get("window").open = () => {};
      await c.call(fn, URL_);
      assert.ok(!toasts.some((t) => /copied to clipboard/i.test(t.message)), JSON.stringify(toasts));
    });
  }
});

describe("sharePreset (copy a preset as JSON)", () => {
  const seed = (c) => c.localStorage.setItem("myListAddon:presets", JSON.stringify({
    Mine: { entries: [{ url: "tmdb:chart:popular", type: "movie", name: "Popular" }] },
  }));

  it("with no clipboard API it copies by the fallback and confirms", async () => {
    const { c } = setup({ clipboard: "absent" });
    seed(c);
    const alerts = [];
    c.set("showAppAlert", (title) => alerts.push(title));
    const doc = c.get("document");
    const made = [];
    const baseCreate = doc.createElement;
    doc.createElement = (...a) => { const el = baseCreate(...a); made.push(el); return el; };
    let copiedJson = null;
    doc.execCommand = () => { const box = made.find((el) => typeof el.value === "string" && el.value.includes("tmdb:chart:popular")); copiedJson = box && box.value; return !!box; };
    await c.call("sharePreset", "Mine");
    assert.ok(copiedJson && JSON.parse(copiedJson).entries.length === 1, "the preset JSON was copied");
    assert.deepEqual(alerts, ["Preset Copied"]);
  });

  it("when nothing can copy, it shows the JSON to copy by hand instead of saying copied", async () => {
    const { c } = setup({ clipboard: "absent", execCommand: "fails" });
    seed(c);
    const shown = [];
    c.set("showAppAlert", (title) => shown.push("alert:" + title));
    c.set("showAppPrompt", (title, msg, text) => shown.push("prompt:" + title + ":" + (text.includes("tmdb:chart:popular") ? "json" : "?")));
    await c.call("sharePreset", "Mine");
    assert.deepEqual(shown, ["prompt:Preset JSON:json"]);
  });
});
