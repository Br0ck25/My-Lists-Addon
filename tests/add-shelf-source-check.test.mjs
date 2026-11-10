// Audit PROD-02: "+ New Catalog" saved a row for a link the app itself calls
// "not a supported list source" (example.com/nothing): a dead row on the TV home
// screen with no message. /api/preview can now answer only whether the source is
// supported (no rate-limit charge, no provider call) and the dialog uses it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";
import { loadClient, requestsTo } from "./client-harness.mjs";

describe("PROD-02: /api/preview validateOnly", () => {
  it("accepts a supported source without calling any provider or using the rate limit", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const r = await call(env, "/api/preview", { method: "POST", json: { url: "https://trakt.tv/users/bob/lists/best", validateOnly: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM rate_counters").get().n, 0, "no rate-limit write");
  });

  it("refuses an unsupported source with the same words the preview uses", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const r = await call(env, "/api/preview", { method: "POST", json: { url: "https://example.com/nothing", validateOnly: true } });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /isn't a supported list source/);
  });

  it("accepts a combined catalog whose links are all supported", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const r = await call(env, "/api/preview", { method: "POST", json: { url: "https://trakt.tv/users/bob/lists/best\nhttps://mdblist.com/lists/a/b", validateOnly: true } });
    assert.equal(r.status, 200, r.text);
  });

  it("checks every link of a combined catalog", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const r = await call(env, "/api/preview", { method: "POST", json: { url: "https://trakt.tv/users/bob/lists/best\nhttps://example.com/x", validateOnly: true } });
    assert.equal(r.status, 400);
  });
});

describe("PROD-02: the New Catalog dialog", () => {
  function setup(previewAnswer) {
    const client = loadClient({ signedIn: "alice", routes: { "/api/preview": () => previewAnswer } });
    const doc = client.document;
    doc.getElementById("addShelfModalName").value = "Bad";
    doc.getElementById("addShelfModalType").value = "movie";
    doc.querySelectorAll = () => [{ value: "https://example.com/nothing" }];
    const toasts = [];
    client.set("showToast", (m, t) => toasts.push({ m, t }));
    const added = [];
    client.set("addRow", (...a) => { added.push(a); });
    client.set("saveState", () => {});
    return { client, toasts, added };
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("does not add the row when the source is not supported, and says why", async () => {
    const { client, toasts, added } = setup({ status: 400, json: { ok: false, error: "That URL isn't a supported list source." } });
    client.call("submitAddShelfModal");
    await flush();
    assert.deepEqual(added, []);
    assert.match(toasts[0].m, /supported list source/);
    assert.equal(toasts[0].t, "error");
    assert.notEqual(client.document.getElementById("addShelfModal").style.display, "none", "the dialog stays open to fix the link");
  });

  it("adds the row when the source is supported", async () => {
    const { client, added } = setup({ json: { ok: true } });
    client.call("submitAddShelfModal");
    await flush();
    assert.equal(added.length, 1);
    assert.equal(requestsTo(client, "/api/preview").length, 1);
  });

  it("still adds the row when the check itself cannot be made (server down)", async () => {
    const { client, added } = setup({ status: 503, json: { ok: false } });
    client.call("submitAddShelfModal");
    await flush();
    assert.equal(added.length, 1, "only a clear 'unsupported' answer blocks");
  });
});
