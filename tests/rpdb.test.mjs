import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// RatingPosterDB artwork: posters come through this Worker's /rpdb/ route so a
// person's monthly request limit is not spent by every render.

const { accountProof, makeKv, makeD1, makeEnv, call } = await import("./harness.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const SHOW = "tt0903747";
const CUSTOM_URL = "customlist:v1:" + JSON.stringify({
  listSlug: "rpdb-roundtrip",
  items: [{ id: SHOW, title: "RPDB Show", year: "2008", type: "series" }],
});
let keyN = 0;
const newKey = () => `t2-test-key-${++keyN}`;

// What RPDB answers. `usage` and `poster` can be changed per test.
function stubRpdb(opts = {}) {
  const log = { posters: [], requests: 0, isValid: 0 };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.ratingposterdb.com/")) return realFetch(input, init);
    if (url.endsWith("/requests")) {
      log.requests++;
      const u = opts.usage || { req: 10, limit: 50000 };
      return new Response(JSON.stringify(u), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/isValid")) {
      log.isValid++;
      return opts.invalid ? new Response("API Key is Invalid", { status: 403 }) : new Response(JSON.stringify({ valid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    log.posters.push(url);
    if (opts.posterStatus) return new Response("no", { status: opts.posterStatus });
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  return log;
}

async function install(extra) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const saved = await call(env, "/api/save", { method: "POST", json: {
    ...(await accountProof(env)),
    entries: [{ id: "rpdb-roundtrip", type: "series", name: "RPDB List", url: CUSTOM_URL }],
    showBadgesStremio: false,
    ...extra,
  } });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  return { env, id: saved.body.id };
}
const poster = async ({ env, id }) => {
  const res = await call(env, `/${id}/catalog/series/rpdb-roundtrip.json`);
  assert.equal(res.status, 200);
  return res.body.metas[0].poster || "";
};
const imdb = (n) => "tt" + String(2000000 + n);

describe("RatingPosterDB poster links", () => {
  it("points the catalog at this Worker's /rpdb/ route, without the key in the URL", async () => {
    const key = newKey();
    const inst = await install({ rpdb: true, rpdbKey: key });
    const p = await poster(inst);
    assert.equal(p, `https://example.test/rpdb/${inst.id}/${SHOW}.jpg`);
    assert.ok(!p.includes(key));
  });

  it("changes nothing while off, or with a key that is not an RPDB key", async () => {
    assert.ok(!(await poster(await install({ rpdb: false, rpdbKey: newKey() }))).includes("/rpdb/"));
    for (const bad of ["abc", "t9", "https://evil.example/x", "t1-" + "a".repeat(80), "t1-a b"]) {
      assert.ok(!(await poster(await install({ rpdb: true, rpdbKey: bad }))).includes("/rpdb/"), bad);
    }
  });

  it("wins over Better Posters, and Pictorium wins over it", async () => {
    const key = newKey();
    assert.ok((await poster(await install({ rpdb: true, rpdbKey: key, betterPosters: true }))).includes("/rpdb/"));
    const both = await poster(await install({ rpdb: true, rpdbKey: key, pictorium: true, pictoriumUrl: "https://p.example.com/api/poster/{type}/{tmdb_id|imdb_id}?u=1" }));
    assert.ok(both.startsWith("https://p.example.com/api/poster/"), both);
  });

  it("is in Settings, with a key test", async () => {
    const html = (await call(makeEnv({}), "/")).text;
    assert.match(html, /id="rpdbCheckbox"/);
    assert.match(html, /id="rpdbKeyInput"/);
    assert.match(html, /Use RatingPosterDB artwork/);
    assert.match(html, /data-act="testRpdbKey"/);
  });
});

describe("the /rpdb/ route spares the person's request limit", () => {
  it("fetches a poster from RPDB once, then serves every later request from its copy", async () => {
    const log = stubRpdb();
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    const first = await call(inst.env, `/rpdb/${inst.id}/${imdb(1)}.jpg`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    for (let i = 0; i < 5; i++) assert.equal((await call(inst.env, `/rpdb/${inst.id}/${imdb(1)}.jpg`)).status, 200);
    assert.equal(log.posters.length, 1, "one RPDB request for six renders");
    assert.ok(log.posters[0].includes("/imdb/poster-default/" + imdb(1) + ".jpg?fallback=true"));
  });

  it("asks RPDB at most 20 new posters a minute; the rest get the ordinary poster for now", async () => {
    const log = stubRpdb();
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    const statuses = [];
    for (let i = 0; i < 26; i++) statuses.push((await call(inst.env, `/rpdb/${inst.id}/${imdb(100 + i)}.jpg`)).status);
    assert.equal(log.posters.length, 20);
    assert.equal(statuses.filter((s) => s === 200).length, 20);
    const over = await call(inst.env, `/rpdb/${inst.id}/${imdb(999)}.jpg`);
    assert.equal(over.status, 302);
    assert.equal(over.headers.get("location"), `https://images.metahub.space/poster/medium/${imdb(999)}/img`);
  });

  it("stops asking once 95% of the monthly limit is used, and serves what it already holds", async () => {
    const log = stubRpdb({ usage: { req: 47600, limit: 50000 } });
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    const r = await call(inst.env, `/rpdb/${inst.id}/${imdb(200)}.jpg`);
    assert.equal(r.status, 302);
    assert.equal(log.posters.length, 0);

    // Held from before: still served.
    const log2 = stubRpdb();
    const inst2 = await install({ rpdb: true, rpdbKey: newKey() });
    await call(inst2.env, `/rpdb/${inst2.id}/${imdb(201)}.jpg`);
    stubRpdb({ usage: { req: 49999, limit: 50000 } });
    assert.equal((await call(inst2.env, `/rpdb/${inst2.id}/${imdb(201)}.jpg`)).status, 200);
    assert.equal(log2.posters.length, 1);
  });

  it("reads the key's usage about once, not once per poster", async () => {
    const log = stubRpdb();
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    for (let i = 0; i < 8; i++) await call(inst.env, `/rpdb/${inst.id}/${imdb(300 + i)}.jpg`);
    assert.equal(log.requests, 1);
  });

  it("backs off after a 429 instead of trying poster after poster", async () => {
    const log = stubRpdb({ posterStatus: 429 });
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    for (let i = 0; i < 6; i++) assert.equal((await call(inst.env, `/rpdb/${inst.id}/${imdb(400 + i)}.jpg`)).status, 302);
    assert.equal(log.posters.length, 1, "asked once, then left alone");
  });

  it("does not keep using a key RPDB refuses", async () => {
    const log = stubRpdb({ posterStatus: 403 });
    const inst = await install({ rpdb: true, rpdbKey: newKey() });
    for (let i = 0; i < 4; i++) assert.equal((await call(inst.env, `/rpdb/${inst.id}/${imdb(500 + i)}.jpg`)).status, 302);
    assert.equal(log.posters.length, 1);
  });

  it("gives the ordinary poster for an install with RPDB off, a bad id, or no such install", async () => {
    const log = stubRpdb();
    const off = await install({ rpdb: false });
    assert.equal((await call(off.env, `/rpdb/${off.id}/${imdb(600)}.jpg`)).status, 302);
    assert.equal((await call(off.env, `/rpdb/${off.id}/tt1.jpg`)).status, 404);
    assert.equal((await call(makeEnv({ CONFIGS: makeKv() }), `/rpdb/nope/${imdb(601)}.jpg`)).status, 302);
    assert.equal(log.posters.length, 0);
  });

  it("keeps one person's copies apart from another's (their settings differ)", async () => {
    const log = stubRpdb();
    const a = await install({ rpdb: true, rpdbKey: newKey() });
    const b = await install({ rpdb: true, rpdbKey: newKey() });
    await call(a.env, `/rpdb/${a.id}/${imdb(700)}.jpg`);
    await call(b.env, `/rpdb/${b.id}/${imdb(700)}.jpg`);
    assert.equal(log.posters.length, 2);
  });
});

describe("Test key", () => {
  it("says whether a key works and how much is used", async () => {
    stubRpdb({ usage: { req: 1502, limit: 50000 } });
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await call(env, "/api/rpdb-check", { method: "POST", json: { key: "t1-abcdef" } });
    assert.deepEqual(r.body, { ok: true, valid: true, used: 1502, limit: 50000 });
  });

  it("reports a key RPDB refuses, and refuses anything that is not a key shape without calling RPDB", async () => {
    const log = stubRpdb({ invalid: true });
    const env = makeEnv({ CONFIGS: makeKv() });
    const bad = await call(env, "/api/rpdb-check", { method: "POST", json: { key: "t1-abcdef" } });
    assert.deepEqual(bad.body, { ok: true, valid: false });
    const junk = await call(env, "/api/rpdb-check", { method: "POST", json: { key: "../../x" } });
    assert.equal(junk.status, 400);
    assert.equal(log.isValid, 1);
  });
});
