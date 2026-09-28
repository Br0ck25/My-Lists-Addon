// P5-9: with the BLOBS bucket and the JOBS queue bound, BetterPosters copies
// live in R2 and are fetched by the poster.fetch job: no request waits on
// btttr.cc. Same fakes as better-posters-mirror.test.mjs.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, makeQueue, drainQueue, call } from "./harness.mjs";

const realFetch = globalThis.fetch;
let upstream = [];
let btttr = () => null;
let metahub = () => null;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://btttr.cc/")) {
    upstream.push(url);
    const r = await btttr(url);
    if (!r) return new Response("gateway timeout", { status: 504 });
    return new Response(r.bytes, { status: 200, headers: { "Content-Type": r.type || "image/webp" } });
  }
  if (url.startsWith("https://images.metahub.space/")) {
    const r = metahub(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.bytes, { status: 200, headers: { "Content-Type": r.type || "image/jpeg" } });
  }
  throw new TypeError("offline in tests: " + url);
};
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { upstream = []; btttr = () => null; metahub = () => null; });

const SITE = { headers: { "Sec-Fetch-Site": "same-origin" } };
const IMG = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8]);
const PLAIN = new Uint8Array([255, 216, 255, 1]);
const R2_KEY = "img/bp/poster/tt1745960/-.-.-.jpg";
const r2Env = () => makeEnv({ CONFIGS: makeKv(), DB: makeD1(), JOBS: makeQueue() });
const posterJobs = (env) => env.JOBS._pending.filter((m) => m.body.type === "poster.fetch").map((m) => m.body.payload.paths);

describe("P5-9: BetterPosters in R2, fetched by poster.fetch", () => {
  it("an app asking for a poster not stored yet gets the ordinary one at once, and a job fetches the real one", async () => {
    const env = r2Env();
    // btttr.cc would take a minute: nothing may wait on it.
    btttr = () => new Promise(() => {});
    metahub = () => ({ bytes: PLAIN });
    const first = await call(env, "/bp/poster/tt1745960.jpg");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-better-poster"), "pending");
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(upstream, [], "no request went to btttr.cc");
    assert.deepEqual(posterJobs(env), [["/bp/poster/tt1745960.jpg"]]);

    // Asked again straight away: not sent twice.
    await call(env, "/bp/poster/tt1745960.jpg");
    assert.equal(posterJobs(env).length, 1);

    btttr = () => ({ bytes: IMG });
    const log = await drainQueue(env);
    assert.deepEqual(log.deliveries.map((d) => [d.type, d.outcome]), [["poster.fetch", "ack"]]);
    assert.deepEqual(upstream, ["https://btttr.cc/poster/imdb/poster-default/tt1745960.jpg"]);
    assert.ok(env.BLOBS._store.has(R2_KEY));
    assert.equal(env.BLOBS._meta.get(R2_KEY).customMetadata.ct, "image/webp");
    assert.ok(![...env.CONFIGS._store.keys()].some((k) => k.startsWith("bpimg:v1:")), "nothing new in KV");

    const served = await call(env, "/bp/poster/tt1745960.jpg");
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/webp");
    assert.equal(served.text, new TextDecoder().decode(IMG));
    assert.equal(upstream.length, 1);
  });

  it("the website gets its own stand-in answer at once, and the job is sent", async () => {
    const env = r2Env();
    btttr = () => new Promise(() => {});
    const r = await call(env, "/bp/poster/tt2000002.jpg", SITE);
    assert.equal(r.status, 503);
    assert.deepEqual(upstream, []);
    assert.equal(posterJobs(env).length, 1);
  });

  it("a copy still in KV is served and moved to R2", async () => {
    const env = r2Env();
    await env.CONFIGS.put("bpimg:v1:poster:tt1745960:::", IMG.buffer, { metadata: { ct: "image/webp", at: Date.now() } });
    const r = await call(env, "/bp/poster/tt1745960.jpg");
    assert.equal(r.status, 200);
    assert.equal(r.text, new TextDecoder().decode(IMG));
    assert.ok(env.BLOBS._store.has(R2_KEY), "copied to R2");
    assert.deepEqual(posterJobs(env), [], "fresh: nothing to fetch");
  });

  it("a copy more than a day old is served and refreshed by a job", async () => {
    const env = r2Env();
    const KEY4 = "img/bp/poster/tt2000004/-.-.-.jpg";
    await env.BLOBS.put(KEY4, IMG, { customMetadata: { ct: "image/webp", at: String(Date.now() - 2 * 86400 * 1000) } });
    const r = await call(env, "/bp/poster/tt2000004.jpg");
    assert.equal(r.status, 200);
    assert.deepEqual(upstream, []);
    assert.equal(posterJobs(env).length, 1);
    const NEWER = new Uint8Array([9, 9, 9]);
    btttr = () => ({ bytes: NEWER });
    await drainQueue(env);
    assert.ok(Number(env.BLOBS._meta.get(KEY4).customMetadata.at) > Date.now() - 60000);
  });

  it("the website's warm-up reports what is stored and hands the rest to the job", async () => {
    const env = r2Env();
    btttr = () => new Promise(() => {});
    await env.BLOBS.put(R2_KEY, IMG, { customMetadata: { ct: "image/webp", at: String(Date.now()) } });
    const r = await call(env, "/api/bp/warm", { method: "POST", json: { urls: ["/bp/poster/tt1745960.jpg", "/bp/poster/tt0903747.jpg"] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ready, ["/bp/poster/tt1745960.jpg"]);
    assert.equal(r.body.fetched, 0);
    assert.deepEqual(upstream, []);
    assert.deepEqual(posterJobs(env), [["/bp/poster/tt0903747.jpg"]]);
  });

  it("without the queue, posters are fetched on the request into KV, as before", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    const r = await call(env, "/bp/poster/tt1745960.jpg");
    assert.equal(r.status, 200);
    assert.equal(upstream.length, 1);
    assert.ok(env.CONFIGS._store.has("bpimg:v1:poster:tt1745960:::"));
    assert.equal(env.BLOBS._store.size, 0);
  });
});
