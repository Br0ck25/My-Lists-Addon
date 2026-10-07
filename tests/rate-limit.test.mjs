import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { awaitFreshRateWindow, call, createUser, freshIsolate, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

// P7-3: every abuse limit in this Worker used to be a KV slot --
// `ratelimit:<bucket>:<ip>` with a TTL, read, compare, written back. Two
// properties made that the wrong shape for a counter:
//
//   1. KV reads are served from the edge cache for up to a minute, so a burst
//      arriving in parallel (which is what a script, a scraper or a password
//      guesser is) all reads the same pre-increment value and all passes. The
//      limit was not a limit in the only conditions it existed for. (S-13.)
//   2. KV has no atomic increment, so even without the cache a read-modify-
//      write across two requests can lose one of them.
//
// The limits now live in D1's `rate_counters` (migration 0015), whose
// (scope, window_start) primary key makes the increment an atomic upsert, and
// where the increment and the read-back happen in one batch transaction --
// which D1 guarantees does not interleave with another batch.
//
// What this file asserts, in order of how much it matters:
//
//   1. Nothing writes a `ratelimit:` key to KV any more, with D1 bound or
//      without it. That is the acceptance criterion of the whole change: the
//      KV namespace keeps the data it is good at (documents, indexes, links)
//      and stops being asked to be a counter.
//   2. Two requests that arrive together cannot both spend a budget of one.
//      This is the property the KV version could not hold, and it is asserted
//      against both storage paths, because the fallback has to be safe too.
//   3. The budget is per bucket, per client, per clock-aligned window, and
//      the window is the only thing that resets it: refused requests still
//      count, so hammering does not earn a fresh budget.
//   4. An unmigrated database (no `rate_counters`) still limits and still
//      serves: the fallback is the isolate's memory, which is looser across
//      isolates but never unlimited.

const RESET_BUDGET = 5; // RESET_KEY_ACCOUNT_MAX_FAILURES (00_constants.js)

describe("P7-3: rate limits are D1 counters, not KV slots", () => {
  const rateKeys = (kv) => [...kv._store.keys()].filter((k) => k.startsWith("ratelimit:"));
  const counter = (env, scope) =>
    env.DB.prepare("SELECT scope, window_start, count FROM rate_counters WHERE scope = ?").bind(scope).first();

  const cspReport = (env, ip, opts = {}) => call(env, "/api/csp-report", {
    method: "POST", ip, w: opts.w,
    headers: { "Content-Type": "application/csp-report", Origin: "" },
    rawBody: JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "https://example.test/x" } }),
  });

  // Both storage paths, because the fallback runs the same call sites: with
  // D1 bound (the supported deployment) and without it (a self-hosted copy,
  // or a database that has not had 0015 applied yet).
  for (const [label, makeStores] of [
    ["D1 bound", () => ({ DB: makeD1() })],
    ["no D1", () => ({})],
  ]) {
    it(`writes no ratelimit: key to KV at all (${label})`, async () => {
      const stores = makeStores();
      const kv = makeKv();
      const env = makeEnv({ ...stores, CONFIGS: kv });
      const ip = nextIp();
      // Four endpoints, four different limiters: profile creation, the
      // browser's CSP reports, a credential guess, and the admin login form.
      await createUser(env, "kcounter" + ip.replace(/\D/g, ""));
      await cspReport(env, ip);
      await call(env, "/api/creator/restore", {
        method: "POST", ip,
        json: { creatorName: "nobody", creatorKey: "MYL-BAD0-BAD0-BAD0" },
      });
      await call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } });

      if (env.DB) {
        // ...and the counters really did move, so an empty KV is not just an
        // empty request path: the row is the proof the limiter ran.
        assert.equal(Number((await counter(env, `csp-report:${ip}`)).count), 1);
        assert.equal(Number((await counter(env, `creatorrestore:${ip}`)).count), 1);
        assert.equal(Number((await counter(env, `adminlogin:${ip}`)).count), 1);
      }
      assert.deepEqual(rateKeys(kv), [], "a rate limit must not cost a KV key, let alone a KV write");
    });

    it(`cannot be spent twice by two requests that arrive together (${label})`, async () => {
      const env = makeEnv({ ...makeStores(), CONFIGS: makeKv() });
      const ip = nextIp();
      const tag = ip.replace(/\D/g, "");
      // The two requests are issued together, so the only thing that could
      // separate them is the window boundary between them (the budget is one
      // per window, and the second window would have its own). Start with
      // most of one to spare.
      await awaitFreshRateWindow();
      // One profile per minute per IP: two names must not both get through.
      // Against the KV version this is exactly the race that let them.
      const [a, b] = await Promise.all([
        call(env, "/api/creator/create", { method: "POST", ip, json: { creatorName: "racea" + tag } }),
        call(env, "/api/creator/create", { method: "POST", ip, json: { creatorName: "raceb" + tag } }),
      ]);
      const created = [a, b].filter((r) => r.body && r.body.ok);
      const refused = [a, b].filter((r) => r.status === 429);
      assert.equal(created.length, 1, `both concurrent profiles were created: ${JSON.stringify([a.body, b.body])}`);
      assert.equal(refused.length, 1);
      assert.deepEqual(rateKeys(env.CONFIGS), []);
    });

    it(`counts every guess in the window, and refuses the one over budget (${label})`, async () => {
      const stores = makeStores();
      const env = makeEnv({ ...stores, CONFIGS: makeKv() });
      const ip = nextIp();
      const other = nextIp();
      // /admin/login allows 10 wrong keys a minute from one address (its daily
      // budget is 50, so the minute is what this exercises). Ten guesses and
      // then a refusal only mean anything inside ONE window, so start with
      // most of one still ahead.
      await awaitFreshRateWindow();
      for (let i = 0; i < 10; i++) {
        const r = await call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } });
        assert.equal(r.status, 401, `guess ${i + 1} should be answered as a wrong key`);
      }
      const over = await call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } });
      assert.equal(over.status, 429, "the 11th guess in one window is over budget");
      // ...and it is per client, not global, so one address cannot lock out
      // another. A limit that a stranger can spend on your behalf is a
      // denial-of-service, not a defence.
      const stranger = await call(env, "/admin/login", { method: "POST", ip: other, form: { key: "wrong-key" } });
      assert.equal(stranger.status, 401, "another address still has its own budget");
      if (env.DB) {
        // Ten, not eleven: this endpoint reads the count, refuses, and only
        // spends when a guess was actually attempted (see reserveRateLimit).
        // The count staying at the ceiling is what keeps it refused for the
        // rest of the window.
        assert.equal(Number((await counter(env, `adminlogin:${ip}`)).count), 10);
        assert.equal(Number((await counter(env, `adminlogin:${other}`)).count), 1);
      }
      assert.deepEqual(rateKeys(env.CONFIGS), []);
    });

    it(`still limits when the counters table is not there (${label})`, async () => {
      // A database that never had migration 0015 applied: the counters are in
      // the isolate's memory instead. Looser -- several isolates each allow
      // the full budget -- but never unlimited, and never a 500.
      const DB = makeD1();
      DB._db.exec("DROP TABLE IF EXISTS rate_counters;");
      const env = makeEnv({ ...makeStores(), DB, CONFIGS: makeKv() });
      const ip = nextIp();
      const tag = ip.replace(/\D/g, "");
      await awaitFreshRateWindow();
      const first = await call(env, "/api/creator/create", { method: "POST", ip, json: { creatorName: "olddb" + tag } });
      assert.equal(first.body.ok, true, `an unmigrated database must still create profiles: ${first.status} ${JSON.stringify(first.body)}`);
      const second = await call(env, "/api/creator/create", { method: "POST", ip, json: { creatorName: "olddb2" + tag } });
      assert.equal(second.status, 429, "the fallback still limits");
      assert.deepEqual(rateKeys(env.CONFIGS), []);
    });
  }

  it("keys the counter by bucket, client and clock-aligned window", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const ip = nextIp();
    await call(env, "/api/creator/restore", {
      method: "POST", ip,
      json: { creatorName: "nobody", creatorKey: "MYL-BAD0-BAD0-BAD0" },
    });
    await cspReport(env, ip);

    const row = await counter(env, `creatorrestore:${ip}`);
    assert.equal(Number(row.count), 1);
    // Aligned to the clock, not started by the first caller: that is what
    // makes the counter one row per (bucket, client, window) rather than a
    // key with a TTL, and what lets a sweep delete spent windows by their
    // window_start.
    assert.equal(row.window_start % 60000, 0, "a one-minute window starts on a minute boundary");
    assert.ok(row.window_start <= Date.now() && Date.now() - row.window_start < 60000);

    // A different bucket from the same address is a different budget, and the
    // two do not add up into each other.
    assert.equal(Number((await counter(env, `csp-report:${ip}`)).count), 1);
    assert.equal(Number((await counter(env, `creatorrestore:${ip}`)).count), 1);
    assert.deepEqual(rateKeys(env.CONFIGS), []);
  });

  it("clears spent windows in the background, and only spent ones", async () => {
    // The sweep is opportunistic -- at most once every ten minutes PER
    // ISOLATE -- so this runs on a cold one and is its first spend.
    const w = await freshIsolate();
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const now = Math.floor(Date.now() / 60000) * 60000;
    const insert = (scope, windowStart, count) => env.DB
      .prepare("INSERT INTO rate_counters (scope, window_start, count) VALUES (?, ?, ?)")
      .bind(scope, windowStart, count).run();
    // Two days old: no window any caller can still be counted against (the
    // longest window in the Worker is fifteen minutes).
    await insert("preview:two-days-ago", now - 48 * 60 * 60 * 1000, 240);
    await insert("preview:this-window", now, 7);

    const ip = nextIp();
    await cspReport(env, ip, { w });

    const scopes = (await env.DB.prepare("SELECT scope FROM rate_counters ORDER BY scope").all())
      .results.map((r) => r.scope);
    assert.ok(!scopes.includes("preview:two-days-ago"), "a window nobody can be counted against any more is swept");
    assert.ok(scopes.includes("preview:this-window"), "a live window is left alone");
    assert.ok(scopes.includes(`csp-report:${ip}`), "and the sweep does not delete the row it just wrote");
  });

  it("still refuses a credential endpoint whose client IP is missing", async () => {
    // consumeRateLimit treats a missing key as "deny" (it used to pass, for
    // self-hosted copies with no Cloudflare in front -- the one branch in this
    // file where a fail-closed default could be argued the other way). Every
    // caller refuses before it gets that far, which is the behaviour that
    // matters: an unthrottleable request is not one to serve.
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const r = await call(env, "/api/creator/create", { method: "POST", ip: null, json: { creatorName: "noiphere" } });
    assert.equal(r.status, 400);
    const restore = await call(env, "/api/creator/restore", {
      method: "POST", ip: null,
      json: { creatorName: "nobody", creatorKey: "MYL-BAD0-BAD0-BAD0" },
    });
    assert.equal(restore.status, 400);
  });

  // Audit AUTH-002: the per-account budget used to be read, then the answer
  // verified, then the failure noted, so every request already past the read
  // verified a guess. 300 parallel guesses all got a 401. The budget is now
  // spent before the answer is checked, so a burst gets the budget and no more.
  it("a parallel burst of wrong recovery answers gets at most the account budget, even from many addresses", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "burstvictim", { recoveryAnswer: "purple elephant" });
    await awaitFreshRateWindow();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      call(env, "/api/creator/reset-key", {
        method: "POST", ip: nextIp(),
        json: { username: user.creatorName, recoveryAnswer: "wrong guess " + i },
      })));
    const verified = results.filter((r) => r.status === 401).length;
    assert.ok(verified <= RESET_BUDGET, `${verified} guesses were verified, the budget is ${RESET_BUDGET}`);
    assert.equal(results.filter((r) => r.status === 429).length, 30 - verified);
  });

  it("one address cannot get past the reset-key IP limit by bursting either", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await awaitFreshRateWindow();
    const ip = nextIp();
    const results = await Promise.all(Array.from({ length: 30 }, () =>
      call(env, "/api/creator/reset-key", { method: "POST", ip, json: { username: "nobodyhere", recoveryAnswer: "whatever it is" } })));
    assert.equal(results.filter((r) => r.status === 429).length, 20, "10 a day, the other 20 refused");
  });

  it("a correct recovery answer gives its spend back", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "refundme", { recoveryAnswer: "purple elephant" });
    for (let i = 0; i < 4; i++) {
      const wrong = await call(env, "/api/creator/reset-key", { method: "POST", ip: nextIp(), json: { username: user.creatorName, recoveryAnswer: "nope " + i } });
      assert.equal(wrong.status, 401);
    }
    const right = await call(env, "/api/creator/reset-key", { method: "POST", ip: nextIp(), json: { username: user.creatorName, recoveryAnswer: "purple elephant" } });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    // Four failures stayed, the success did not count: one more wrong guess
    // is the fifth, and it is still verified rather than refused.
    const fifth = await call(env, "/api/creator/reset-key", { method: "POST", ip: nextIp(), json: { username: user.creatorName, recoveryAnswer: "nope again" } });
    assert.equal(fifth.status, 401);
  });

  it("a parallel burst of wrong admin keys is capped at the per-minute budget", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await awaitFreshRateWindow();
    const ip = nextIp();
    const results = await Promise.all(Array.from({ length: 30 }, () =>
      call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } })));
    assert.equal(results.filter((r) => r.status === 401).length, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 20);
  });

  // Audit DATA-001: the anonymous search endpoints spend the owner's TMDB key,
  // had no limit, and every distinct query minted stats rows that nothing
  // deletes.
  describe("anonymous search endpoints (DATA-001)", () => {
    const realFetch = globalThis.fetch;
    const stub = () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const restore = () => { globalThis.fetch = realFetch; };

    for (const [label, path] of [
      ["/api/title-search", (i) => `/api/title-search?q=unique${i}&type=movie`],
      ["/api/person-search", (i) => `/api/person-search?q=unique${i}`],
      ["/api/tmdb-search-lists", (i) => `/api/tmdb-search-lists?q=unique${i}`],
      ["the Stremio search catalog", (i) => `/catalog/movie/search_movies/search=unique${i}.json`],
    ]) {
      it(`${label} refuses an address past 60 a minute, and another address still searches`, async () => {
        stub();
        try {
          const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "k" });
          await awaitFreshRateWindow();
          const ip = nextIp();
          const statuses = [];
          for (let i = 0; i < 64; i++) statuses.push((await call(env, path(i), { ip })).status);
          assert.equal(statuses.filter((c) => c === 429).length, 4, `the 61st to 64th are refused: ${statuses.join(",")}`);
          const other = await call(env, path(999), { ip: nextIp() });
          assert.notEqual(other.status, 429, "a limit one address spends must not stop another");
        } finally {
          restore();
        }
      });
    }

    it("stops writing search-query rows once the day's ceiling is spent", async () => {
      stub();
      try {
        const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "k" });
        const count = () => Number(env.DB._db.prepare("SELECT count(*) AS n FROM stats WHERE kind LIKE 'searchq:%'").get().n);
        await call(env, "/api/title-search?q=firstquery&type=movie");
        assert.ok(count() > 0, "an ordinary search is still recorded");
        const before = count();
        const windowStart = Math.floor(Date.now() / 86400000) * 86400000;
        env.DB._db.prepare("INSERT INTO rate_counters (scope, window_start, count) VALUES (?, ?, ?) ON CONFLICT(scope, window_start) DO UPDATE SET count = excluded.count")
          .run("searchrecord:all", windowStart, 20000);
        await call(env, "/api/title-search?q=secondquery&type=movie");
        await call(env, "/api/title-search?q=thirdquery&type=movie");
        assert.equal(count(), before, "over the ceiling nothing new is written");
      } finally {
        restore();
      }
    });
  });

  // Audit DOS-001: a wrong, well-formed Account Key in forgot-username walked
  // the first 50 accounts and ran PBKDF2 on each.
  describe("forgot-username with an unknown key (DOS-001)", () => {
    const WRONG = "MYL-AAAA-BBBB-CCCC";
    async function countDerivations(fn) {
      const real = globalThis.crypto.subtle.deriveBits.bind(globalThis.crypto.subtle);
      let n = 0;
      globalThis.crypto.subtle.deriveBits = (...a) => { n++; return real(...a); };
      try { await fn(); } finally { globalThis.crypto.subtle.deriveBits = real; }
      return n;
    }

    it("does not hash against accounts that are already indexed", async () => {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
      for (let i = 0; i < 8; i++) await createUser(env, "indexed" + i);
      let status;
      const n = await countDerivations(async () => {
        status = (await call(env, "/api/creator/forgot-username", { method: "POST", ip: nextIp(), json: { creatorKey: WRONG } })).status;
      });
      assert.equal(status, 401);
      assert.equal(n, 0, `${n} key derivations for one wrong key`);
    });

    it("still finds an old account that has no lookup entry, and indexes it", async () => {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
      const old = await createUser(env, "oldaccount");
      env.DB._db.prepare("DELETE FROM creator_key_lookups").run();
      env.DB._db.prepare("UPDATE accounts SET key_lookup_hmac = NULL").run();
      for (const k of [...env.CONFIGS._store.keys()]) if (k.startsWith("keylookup:") || k.startsWith("creatorlookuphash:")) env.CONFIGS._store.delete(k);
      const first = await call(env, "/api/creator/forgot-username", { method: "POST", ip: nextIp(), json: { creatorKey: old.creatorKey } });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.username, "oldaccount");
      const n = await countDerivations(async () => {
        await call(env, "/api/creator/forgot-username", { method: "POST", ip: nextIp(), json: { creatorKey: WRONG } });
      });
      assert.equal(n, 0, "once indexed the account is no longer scanned");
    });
  });
});
