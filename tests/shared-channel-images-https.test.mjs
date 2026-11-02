// SEC-08 (owner decision 2026-11-02: HTTPS only): a shared channel's poster,
// backdrop and item images are loaded by everyone who adds the channel. An
// http:// image loads without encryption (and exposes the viewer's address to
// whatever host it names), so only https:// images are kept. Any https host
// stays allowed, so custom logos on hosts such as Imgur keep working. A dropped
// image falls back to the channel's generated poster.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";
import { loadClient } from "./client-harness.mjs";

const item = (extra) => ({ kind: "episode", imdbId: "tt0108778", season: 5, episode: 13, showName: "Friends", epName: "The One", title: "Friends S5E13", ...extra });

async function shared(channel) {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const u = await createUser(env, "imgowner");
  const r = await call(env, "/api/channel/share", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, channel } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return JSON.parse(env.CONFIGS._store.get("channelshare:" + r.body.code)).channel;
}

describe("SEC-08: shared channel images are https only", () => {
  it("keeps an https image on any host, including a custom logo host", async () => {
    const ch = await shared({
      name: "Logos", poster: "https://i.imgur.com/x.png", backdrop: "https://example.org/b.jpg",
      items: [item({ poster: "https://cdn.example.net/p.jpg", thumbnail: "https://cdn.example.net/t.jpg", showPoster: "https://i.imgur.com/s.png", backdrop: "https://cdn.example.net/bd.jpg" })],
    });
    assert.equal(ch.poster, "https://i.imgur.com/x.png");
    assert.equal(ch.backdrop, "https://example.org/b.jpg");
    assert.equal(ch.items[0].poster, "https://cdn.example.net/p.jpg");
    assert.equal(ch.items[0].thumbnail, "https://cdn.example.net/t.jpg");
    assert.equal(ch.items[0].showPoster, "https://i.imgur.com/s.png");
  });

  it("drops http:// images, so the generated poster is used", async () => {
    const ch = await shared({
      name: "Plain", poster: "http://i.imgur.com/x.png", backdrop: "http://example.org/b.jpg",
      items: [item({ poster: "http://cdn.example.net/p.jpg", thumbnail: "HTTP://cdn.example.net/t.jpg", showPoster: "http://i.imgur.com/s.png" })],
    });
    assert.equal(ch.poster, null);
    assert.equal(ch.backdrop, null);
    assert.ok(!ch.items[0].poster && !ch.items[0].thumbnail && !ch.items[0].showPoster);
  });

  it("drops javascript:, data: and other schemes and malformed values", async () => {
    const bad = ["javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://example.com/a.png", "//example.com/a.png", "https:", "https://", "not a url", "  "];
    for (const value of bad) {
      const ch = await shared({ name: "Bad", poster: value, items: [item({ poster: value })] });
      assert.equal(ch.poster, null, `poster ${JSON.stringify(value)}`);
      assert.ok(!ch.items[0].poster, `item poster ${JSON.stringify(value)}`);
    }
  });
});

describe("SEC-08: the channel builder says https only", () => {
  function run(value) {
    const c = loadClient();
    const doc = c.get("document");
    doc.getElementById("channelPosterUrlInput").value = value;
    const status = doc.getElementById("channelPosterUrlStatus");
    c.call("applyChannelPosterUrl");
    return { status, c };
  }
  it("refuses an http:// logo URL with a message instead of saving it", () => {
    const { status, c } = run("http://example.com/logo.png");
    assert.match(status.textContent, /https/i);
    assert.equal(status.style.color, "var(--color-danger-text)");
    assert.notEqual(c.get("channelDraftPoster"), "http://example.com/logo.png");
  });
  it("accepts an https:// logo URL", () => {
    const { c } = run("https://i.imgur.com/logo.png");
    assert.equal(c.get("channelDraftPoster"), "https://i.imgur.com/logo.png");
  });
});
