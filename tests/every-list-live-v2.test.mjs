import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

// The public site's "every list is live" (Br0ck25/My-Lists #76 and #77,
// ported onto this repository in Release 1) over the v2 list tables.
//
// readLiveCreatorList (05_catalog-core.js) is what a Custom List catalog row
// and its shelf title read. Once FF_V2_LISTS_READ is on and the account's
// copy has finished, it reads the v2 tables (listsV2LiveListRecord,
// 34_lists-v2-bridge.js); with FF_V2_LISTS_ONLY the legacy creatorlist: keys
// are no longer written, so the v2 tables are the only place an edit can be
// seen. The rule stays the legacy one: a public list to anyone, a private one
// only to a reader that proved it owns the account.

const item = (n) => ({ id: `tt000000${n}`, imdbId: `tt000000${n}`, type: "movie", title: `Title ${n}` });

const creatorRow = (owner, items) => "customlist:v1:" + JSON.stringify({
  listId: "L2", creatorSlug: "faves", listSlug: "faves", creatorOwner: owner,
  type: "movie", items, shuffle: false,
});

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

async function runListsCopy(env) {
  const cookie = await adminCookie(env);
  for (let i = 0; i < 500; i++) {
    const r = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.done) return;
  }
  throw new Error("the list copy did not finish");
}

async function saveFaves(env, user, items, visibility, name = "Faves") {
  const r = await call(env, "/api/creator/lists/save", {
    method: "POST",
    json: {
      creatorName: user.creatorName, creatorKey: user.creatorKey,
      slug: "faves", name, type: "movie", items, visibility,
    },
  });
  assert.equal(r.body && r.body.ok, true, JSON.stringify(r.body));
}

// An install link. With the owner's Creator Key it proves the account; with a
// wrong one it only names it, which must never be enough for a private list.
// (A wrong key rather than none: a link saved before keys were stamped, with
// no key at all, is honoured by LEGACY_UNVERIFIED_CONFIG_SHELVES, a separate
// and deliberate rule -- see 00_constants.js.)
async function installLink(env, id, user, { proven }) {
  const cfg = {
    trackCreatorName: user.creatorName,
    trackCreatorKey: proven ? user.creatorKey : "MYL-WRNG-WRNG-WRNG",
    entries: [{ id: "faves", type: "movie", name: "Faves", url: creatorRow(user.creatorName, [item(1)]), enabled: true }],
  };
  await env.CONFIGS.put(`cfg:${id}`, JSON.stringify(cfg));
  return id;
}

const catalogIds = async (env, config) =>
  ((await call(env, `/${config}/catalog/movie/faves.json`)).body.metas || []).map((m) => m.id);

const manifestName = async (env, config) => {
  const r = await call(env, `/${config}/manifest.json`);
  const cat = (r.body.catalogs || []).find((c) => c.id === "faves");
  return cat ? cat.name : null;
};

async function setup(visibility) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_READ: "1" });
  const ann = await createUser(env, "annlive");
  await saveFaves(env, ann, [item(1), item(2)], visibility);
  await runListsCopy(env);
  const mine = await installLink(env, "livev2own01", ann, { proven: true });
  const claimed = await installLink(env, "livev2clm01", ann, { proven: false });
  return { env, ann, mine, claimed };
}

describe("every list is live, over the v2 list tables", () => {
  it("serves a private list's current items to its proven owner, from v2", async () => {
    const { env, mine } = await setup("private");
    assert.deepEqual(await catalogIds(env, mine), ["tt0000001", "tt0000002"],
      "the live copy, not the one-item snapshot in the row");
  });

  it("never serves a private list to a link that only names the account", async () => {
    const { env, claimed } = await setup("private");
    assert.deepEqual(await catalogIds(env, claimed), ["tt0000001"], "the row's own snapshot");
  });

  it("serves a public list live to any link", async () => {
    const { env, claimed } = await setup("public");
    assert.deepEqual(await catalogIds(env, claimed), ["tt0000001", "tt0000002"]);
  });

  it("with FF_V2_LISTS_ONLY, an edit and a rename reach the apps though the legacy keys stop moving", async () => {
    const { env, ann, mine } = await setup("private");
    env.FF_V2_LISTS_ONLY = "1";
    const legacyBefore = await env.CONFIGS.get("creatorlist:annlive:faves");

    await saveFaves(env, ann, [item(2), item(3)], "private", "Favourites");

    assert.equal(await env.CONFIGS.get("creatorlist:annlive:faves"), legacyBefore,
      "the legacy record did not move, so what follows can only have come from v2");
    assert.deepEqual(await catalogIds(env, mine), ["tt0000002", "tt0000003"], "the removal and the add both reached the row");
    assert.equal(await manifestName(env, mine), "Favourites", "and the rename reached the shelf title");
  });

  it("with FF_V2_LISTS_ONLY, a list that is private in v2 stays private to a link that only names it", async () => {
    const { env, claimed } = await setup("private");
    env.FF_V2_LISTS_ONLY = "1";
    assert.deepEqual(await catalogIds(env, claimed), ["tt0000001"]);
  });
});
