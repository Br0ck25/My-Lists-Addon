// An install link the Worker cannot find.
//
// It used to answer 200 with the generic add-on (two search catalogs, no
// lists) and cache that for an hour. Two ways that goes wrong: a link whose
// record is not yet visible where the app asked (Workers KV is eventually
// consistent) installs an add-on that looks broken and stays that way for an
// hour, and a mistyped or deleted link installs "successfully" and shows
// nothing. The manifest is now a 404 and nothing is cached, so a retry works.
// A link that resolves but is simply empty (the oldest base64 links) is still a
// working add-on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newEnv = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

async function savedInstall(env) {
  const r = await call(env, "/api/save", {
    method: "POST",
    json: { entries: [{ id: "row1", url: "https://mdblist.com/lists/u/l", name: "Row", type: "movie" }] },
  });
  assert.equal(r.body.ok, true);
  return r.body.id;
}

describe("an install link that does not resolve", () => {
  it("the manifest is a 404, not cached, and readable by a browser-based app", async () => {
    const r = await call(newEnv(), "/nonexistent123/manifest.json");
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("access-control-allow-origin"), "*", "Stremio Web must be able to read the error");
  });

  it("so is a well-formed v2 install token nobody holds", async () => {
    const r = await call(newEnv(), "/i/" + "A".repeat(43) + "/manifest.json");
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("a catalog row asked of it is empty and not cached", async () => {
    const r = await call(newEnv(), "/nonexistent123/catalog/movie/row1.json");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.metas, []);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("a channel's meta asked of it is empty and not cached", async () => {
    const r = await call(newEnv(), "/nonexistent123/meta/series/channel_x.json");
    assert.deepEqual(r.body, { meta: null });
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("a row that is not in a real install is empty and not cached either", async () => {
    const env = newEnv();
    const id = await savedInstall(env);
    const r = await call(env, `/${id}/catalog/movie/not-a-row.json`);
    assert.deepEqual(r.body.metas, []);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
});

describe("an install link that does resolve is unchanged", () => {
  it("a saved install's manifest is a 200 and keeps its normal caching", async () => {
    const env = newEnv();
    const id = await savedInstall(env);
    const r = await call(env, `/${id}/manifest.json`);
    assert.equal(r.status, 200);
    assert.ok(r.body.catalogs.some((c) => c.id === "row1"));
    assert.match(r.headers.get("cache-control"), /max-age=3600/);
  });

  it("an old self-contained base64 link with rows is a 200", async () => {
    const link = b64url({ entries: [{ id: "row9", url: "https://mdblist.com/lists/u/l", type: "movie", name: "Old" }] });
    const r = await call(newEnv(), `/${link}/manifest.json`);
    assert.equal(r.status, 200);
    assert.ok(r.body.catalogs.some((c) => c.id === "row9"));
  });

  it("an old base64 link that is valid but empty is a 200, not a not-found", async () => {
    const r = await call(newEnv(), `/${b64url([])}/manifest.json`);
    assert.equal(r.status, 200);
  });
});

// /api/save stores whatever rows it is given, and the manifest is built from
// them: a row with no id made a catalog without one (Stremio rejects the whole
// add-on), an id with a slash cannot be routed, and a type that is not movie or
// series is not a catalog. Refused at the door, like the other limits there.
describe("/api/save refuses rows that would make a broken add-on", () => {
  const good = { id: "row1", url: "https://mdblist.com/lists/u/l", name: "Row", type: "movie" };
  const save = (entries) => call(newEnv(), "/api/save", { method: "POST", json: { entries } });

  it("saves a well-formed row", async () => {
    const r = await save([good]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("refuses a row with no id", async () => {
    const r = await save([{ ...good, id: undefined }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  });

  it("refuses an id that cannot be a catalog id in a URL (slash, space, too long)", async () => {
    for (const id of ["a/b", "has space", "x".repeat(101), "", 7]) {
      const r = await save([{ ...good, id }]);
      assert.equal(r.status, 400, "id " + JSON.stringify(id));
    }
  });

  it("refuses a type that is not movie or series", async () => {
    for (const type of ["episode", "mixed", "", undefined, "MOVIE"]) {
      const r = await save([{ ...good, type }]);
      assert.equal(r.status, 400, "type " + JSON.stringify(type));
    }
  });

  it("refuses a row that is not an object", async () => {
    const r = await save([good, "not a row", null]);
    assert.equal(r.status, 400);
  });

  it("one bad row refuses the whole save, and nothing is stored", async () => {
    const env = newEnv();
    const r = await call(env, "/api/save", { method: "POST", json: { entries: [good, { ...good, id: "a/b" }] } });
    assert.equal(r.status, 400);
    const { keys } = await env.CONFIGS.list({ prefix: "cfg:" });
    assert.equal(keys.length, 0);
  });
});
