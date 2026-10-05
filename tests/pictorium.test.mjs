import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pictorium artwork (the person's own Pictorium space, pasted as a poster
// link) and the "Use My Lists Addon metadata" setting (provideMetadata).

const { accountProof, makeKv, makeD1, makeEnv, call } = await import("./harness.mjs");

const HOST = "https://pictorium.duckdns.org/api/poster";
const AIO = `${HOST}/{type}/{tmdb_id|imdb_id}?u=66f259ec-603f-477a-8045-b49cfedf74b4&live=1&rv=345a067676`;
const NUVIO = `${AIO}&shape={shape}`;
const SHOW = "tt0903747";
const CUSTOM_URL = "customlist:v1:" + JSON.stringify({
  listSlug: "pic-roundtrip",
  items: [{ id: SHOW, title: "Pic Show", year: "2008", type: "series" }],
});

async function saveAndFetch(extra) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const saved = await call(env, "/api/save", { method: "POST", json: {
    ...(await accountProof(env)),
    entries: [{ id: "pic-roundtrip", type: "series", name: "Pic List", url: CUSTOM_URL }],
    showBadgesStremio: false,
    ...extra,
  } });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  const res = await call(env, `/${saved.body.id}/catalog/series/pic-roundtrip.json`);
  assert.equal(res.status, 200);
  assert.ok(res.body.metas && res.body.metas.length);
  return { env, id: saved.body.id, poster: res.body.metas[0].poster || "" };
}

describe("Pictorium artwork", () => {
  it("fills the pasted AIOMetadata link in with the show's type and IMDb id", async () => {
    const { poster } = await saveAndFetch({ pictorium: true, pictoriumUrl: AIO });
    assert.equal(poster, `${HOST}/series/${SHOW}?u=66f259ec-603f-477a-8045-b49cfedf74b4&live=1&rv=345a067676`);
  });

  it("drops the Nuvio link's {shape} instead of sending it", async () => {
    const { poster } = await saveAndFetch({ pictorium: true, pictoriumUrl: NUVIO });
    assert.equal(poster, `${HOST}/series/${SHOW}?u=66f259ec-603f-477a-8045-b49cfedf74b4&live=1&rv=345a067676`);
  });

  it("wins when Better Posters is on too", async () => {
    const { poster } = await saveAndFetch({ pictorium: true, pictoriumUrl: AIO, betterPosters: true });
    assert.ok(poster.startsWith(`${HOST}/series/`), poster);
  });

  it("changes nothing while it is off, even with a link saved", async () => {
    const { poster } = await saveAndFetch({ pictorium: false, pictoriumUrl: AIO });
    assert.ok(!poster.includes("/api/poster/"), poster);
  });

  for (const [why, url] of [
    ["is not https", AIO.replace("https://", "http://")],
    ["points at an IP address", AIO.replace("pictorium.duckdns.org", "10.0.0.5")],
    ["points at localhost", AIO.replace("pictorium.duckdns.org", "localhost")],
    ["points at a .local name", AIO.replace("pictorium.duckdns.org", "box.local")],
    ["has credentials in it", AIO.replace("https://", "https://user:pw@")],
    ["is not a poster path", AIO.replace("/api/poster/", "/other/")],
    ["lacks {type}", AIO.replace("{type}", "movie")],
    ["lacks the id placeholder", AIO.replace("{tmdb_id|imdb_id}", "tt1")],
    ["is not a link", "not a link {type} {tmdb_id|imdb_id}"],
  ]) {
    it(`ignores a link that ${why}`, async () => {
      const { poster } = await saveAndFetch({ pictorium: true, pictoriumUrl: url });
      assert.ok(!poster.includes("/api/poster/") && !poster.includes("/bp/"), poster);
    });
  }

  it("is shown in Settings", async () => {
    const html = (await call(makeEnv({}), "/")).text;
    assert.match(html, /id="pictoriumCheckbox"/);
    assert.match(html, /id="pictoriumUrlInput"/);
    assert.match(html, /Use Pictorium artwork/);
  });
});

describe("Use My Lists Addon metadata", () => {
  const resourceNames = (m) => m.resources.map((r) => (typeof r === "string" ? r : r.name));

  it("is on by default: the manifest offers meta", async () => {
    const { env, id } = await saveAndFetch({});
    const m = (await call(env, `/${id}/manifest.json`)).body;
    assert.deepEqual(resourceNames(m), ["catalog", "meta"]);
    assert.deepEqual(m.idPrefixes, ["tt", "tmdb:", "channel_"]);
  });

  it("off: only TV Channel ids are answered here, and the catalogs and search stay", async () => {
    const { env, id } = await saveAndFetch({ provideMetadata: false });
    const m = (await call(env, `/${id}/manifest.json`)).body;
    assert.deepEqual(resourceNames(m), ["catalog", "meta"]);
    assert.deepEqual(m.resources[1].idPrefixes, ["channel_"]);
    assert.deepEqual(m.idPrefixes, ["channel_"]);
    assert.ok(m.catalogs.some((c) => c.id === "pic-roundtrip"));
    assert.ok(m.catalogs.some((c) => c.id === "search_movies") && m.catalogs.some((c) => c.id === "search_series"));
  });

  it("is shown in Settings", async () => {
    const html = (await call(makeEnv({}), "/")).text;
    assert.match(html, /id="provideMetadataCheckbox"/);
  });
});
