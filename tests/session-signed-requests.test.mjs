// Release 19, the first stage of the sign-in move: the page signs the requests
// that read and save an account's data with its session cookie, not the
// Account Key, and falls back to the key when the session is gone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";
import { loadClient } from "./client-harness.mjs";

describe("the server: a session signs a save in place of the key", () => {
  async function setup() {
    const db = makeD1();
    const env = makeEnv({ DB: db, CONFIGS: makeKv(), FF_SESSIONS: "1" });
    const user = await createUser(env, "sessionsaver");
    // What the page does today: a save with the key, which also hands this
    // browser a session.
    const first = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config: [] },
    });
    assert.equal(first.body.ok, true, JSON.stringify(first.body));
    const cookie = ((first.headers.get("set-cookie") || "").match(/(mla_session=[^;]+)/) || [])[1];
    assert.ok(cookie, "the key-signed save hands out a session");
    return { env, db, user, cookie };
  }

  it("accepts a save with the session alone, and counts only the key-signed one", async () => {
    const { env, db, user, cookie } = await setup();
    assert.equal(db._stat("authkey", "total"), 1);
    const r = await call(env, "/api/creator/sync/save", {
      method: "POST", cookie, json: { creatorName: user.creatorName, config: [{ id: "a", name: "A", url: "https://x" }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(db._stat("authkey", "total"), 1, "a session-signed save is not a key use");
    assert.equal(r.headers.get("x-mla-session"), "sessionsaver", "the page is told whose session it holds");
  });

  it("does not mark an answer without a session", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const u = await createUser(env, "nosessions");
    const r = await call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [] } });
    assert.equal(r.body.ok, true);
    assert.equal(r.headers.get("x-mla-session"), null, "FF_SESSIONS off: nothing to say");
  });

  it("the sign-in check on page load works with the session alone, and a keyless miss is not a failed attempt", async () => {
    const { env, db, user, cookie } = await setup();
    const ok = await call(env, "/api/creator/restore", { method: "POST", cookie, json: { creatorName: user.creatorName } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.creatorName, user.creatorName);
    assert.equal(ok.headers.get("x-mla-session"), user.creatorName.toLowerCase());
    // Without the cookie (an ended session): refused, and no failed attempt noted.
    const ip = "198.51.100.77";
    for (let i = 0; i < 3; i++) {
      const miss = await call(env, "/api/creator/restore", { method: "POST", ip, json: { creatorName: user.creatorName } });
      assert.equal(miss.status, 401);
    }
    // Failed attempts are stats rows "authfail:restore:<ip>" (reserveAuthAttempt),
    // and the per-minute bucket is a rate_counters row.
    // The spend is taken before the key is checked and given back when nothing
    // was guessed, so the rows may exist; what must be zero is what they hold.
    const failRows = db._db.prepare("SELECT coalesce(sum(n), 0) AS n FROM stats WHERE kind LIKE 'authfail:restore:%'").get();
    const bucketRows = db._db.prepare("SELECT coalesce(sum(count), 0) AS n FROM rate_counters WHERE scope LIKE 'creatorrestore%'").get();
    assert.equal(Number(failRows.n) + Number(bucketRows.n), 0, "a keyless miss spends nothing");
    // A wrong key still does.
    await call(env, "/api/creator/restore", { method: "POST", ip, json: { creatorName: user.creatorName, creatorKey: "MYL-WRONG-KEY1-KEY2" } });
    assert.equal(Number(db._db.prepare("SELECT coalesce(sum(n), 0) AS n FROM stats WHERE kind LIKE 'authfail:restore:%'").get().n), 1, "a wrong key is noted");
  });

  it("a preview of a personal row is signed by the session", async () => {
    const { env, user, cookie } = await setup();
    const r = await call(env, "/api/preview", { method: "POST", cookie, json: { creatorName: user.creatorName, entry: { type: "movie", url: `autotrack:watchlist:movie:${user.creatorName}` } } });
    assert.notEqual(r.status, 401, JSON.stringify(r.body));
  });

  it("refuses a session for another account, and a request with neither", async () => {
    const { env, cookie } = await setup();
    const other = await createUser(env, "someoneelse");
    const wrong = await call(env, "/api/creator/sync/save", { method: "POST", cookie, json: { creatorName: other.creatorName, config: [] } });
    assert.equal(wrong.status, 401);
    const none = await call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: other.creatorName, config: [] } });
    assert.equal(none.status, 401);
  });
});

describe("the page: creatorApiFetch", () => {
  const SAVE = "/api/creator/sync/save";
  const body = (o) => JSON.stringify(o);
  const HELD = "myListAddon:sessionFor";
  // The server's answer: X-MLA-Session names the account whose session this
  // browser holds, when it holds one.
  const answer = (req, session) => (req.body.creatorKey || session
    ? { json: { ok: true }, headers: { "X-MLA-Session": "ann" } }
    : { status: 401, json: { ok: false } });

  it("a fresh browser sends the key, and learns from the answer that it now has a session", async () => {
    const seen = [];
    const client = loadClient({ routes: { [SAVE]: (req) => { seen.push(req.body); return answer(req, false); } } });
    await client.call("creatorApiFetch", "https://example.com" + SAVE, { method: "POST", body: body({ creatorName: "ann", creatorKey: "MYL-K" }) });
    assert.equal(seen[0].creatorKey, "MYL-K");
    assert.equal(client.localStorage.getItem(HELD), "ann");
  });

  it("with a session known for the account, sends a data route without the key", async () => {
    const seen = [];
    const client = loadClient({ storage: { [HELD]: "ann" }, routes: { [SAVE]: (req) => { seen.push(req.body); return answer(req, true); } } });
    const res = await client.call("creatorApiFetch", "https://example.com" + SAVE, { method: "POST", body: body({ creatorName: "ann", creatorKey: "MYL-K", config: [] }) });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].creatorKey, undefined, "no key");
    assert.equal(seen[0].creatorName, "ann", "the name still says whose session it must be");
  });

  it("not for another account than the one the session is for", async () => {
    const seen = [];
    const client = loadClient({ storage: { [HELD]: "ann" }, routes: { [SAVE]: (req) => { seen.push(req.body); return { json: { ok: true } }; } } });
    await client.call("creatorApiFetch", "https://example.com" + SAVE, { method: "POST", body: body({ creatorName: "bob", creatorKey: "MYL-B" }) });
    assert.equal(seen[0].creatorKey, "MYL-B");
  });

  it("sends it again with the key when the session is gone, and forgets it until told again", async () => {
    const seen = [];
    const client = loadClient({ storage: { [HELD]: "ann" }, routes: { [SAVE]: (req) => { seen.push(req.body); return req.body.creatorKey ? { json: { ok: true } } : { status: 401, json: { ok: false } }; } } });
    const res = await client.call("creatorApiFetch", "https://example.com" + SAVE, { method: "POST", body: body({ creatorName: "ann", creatorKey: "MYL-K" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.map((b) => b.creatorKey), [undefined, "MYL-K"]);
    assert.equal(client.localStorage.getItem(HELD), null, "no session header came back");
    await client.call("creatorApiFetch", "https://example.com" + SAVE, { method: "POST", body: body({ creatorName: "ann", creatorKey: "MYL-K" }) });
    assert.equal(seen[2].creatorKey, "MYL-K", "the next one sends the key straight away");
  });

  it("keeps the key where the key is what is checked", async () => {
    const seen = [];
    const DELETE = "/api/creator/delete-account";
    const client = loadClient({ storage: { [HELD]: "ann" }, routes: { [DELETE]: (req) => { seen.push(req.body); return { json: { ok: true } }; } } });
    await client.call("creatorApiFetch", "https://example.com" + DELETE, { method: "POST", body: body({ creatorName: "ann", creatorKey: "MYL-K", confirm: "DELETE" }) });
    assert.equal(seen[0].creatorKey, "MYL-K");
  });

  it("every page call to /api/creator/ goes through it", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "..");
    const files = fs.readdirSync(root).filter((f) => /^(09|1\d|2[0-4])_.*\.js$/.test(f));
    const direct = [];
    for (const f of files) {
      fs.readFileSync(path.join(root, f), "utf8").split(/\r?\n/).forEach((line, i) => {
        if (/(^|[^A-Za-z])fetch\(ORIGIN \+ '\/api\/(creator\/|preview|save|feedback|lists\/like|channel\/like|channel\/unpublish)/.test(line)) direct.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(direct, []);
  });
});

// Found while checking the above in a real browser: a page answered with 304
// carried a Content-Security-Policy with a fresh nonce. The browser keeps its
// stored page and takes the 304's headers, so the stored page's scripts (with
// the nonce they were first sent with) were all refused: after a reload the
// page loaded with none of its scripts running.
describe("a page's 304 keeps the policy the browser already has", () => {
  it("sends no Content-Security-Policy on a 304, and one on the 200 that matches its scripts", async () => {
    const env = makeEnv();
    const first = await call(env, "/");
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "the page has an ETag");
    const csp = first.headers.get("content-security-policy") || "";
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    assert.ok(nonce && first.text.includes(`nonce="${nonce}"`), "the 200's scripts carry the 200's nonce");

    const again = await call(env, "/", { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("content-security-policy"), null, "no new nonce on the 304");
    assert.equal(again.headers.get("content-security-policy-report-only"), null);
  });
});
