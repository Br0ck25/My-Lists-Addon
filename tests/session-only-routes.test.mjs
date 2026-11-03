// SEC-03: once a browser forgets the Account Key (FF_FORGET_KEY) every request it
// makes is signed by the session cookie alone: the account name, no key. This
// walks every account route the page calls and checks that a session-only
// request is accepted by each (it must not be answered "Username or Key is
// incorrect" or 401), and that the same request with no session is refused.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

const AUTH_REFUSED = /Username or Key is incorrect|Sign in|sign in|not signed in|Unauthorized/i;

// Every account route the page calls (grep of src/client for /api/...), with a
// minimal body. The body only has to get past authentication; what the route
// does after that is covered by its own tests.
const ROUTES = [
  ["/api/creator/restore", {}],
  ["/api/creator/sync/load", {}],
  ["/api/creator/sync/meta", {}],
  ["/api/creator/sync/save", { config: [] }],
  ["/api/creator/sync/save-tracking", { watchHistory: [] }],
  ["/api/creator/sync/save-presets", { presets: {} }],
  ["/api/creator/sync/save-channels", { channels: {} }],
  ["/api/creator/sync/like", { usernameSlug: "someone:slug", liked: true }],
  ["/api/creator/lists", {}],
  ["/api/creator/lists/items", { slug: "nope" }],
  ["/api/creator/lists/save", { slug: "s1", name: "S1", type: "movie", items: [] }],
  ["/api/creator/lists/delete", { slug: "s1" }],
  ["/api/creator/lists/reorder", { order: [] }],
  ["/api/creator/track-status", {}],
  ["/api/creator/scrobble-token", {}],
  ["/api/creator/scrobble-seen-users", {}],
  ["/api/creator/recovery-answer", { recoveryAnswer: "a long enough answer" }],
  ["/api/preview", { entries: [] }],
  ["/api/save", { entries: [] }],
  ["/api/feedback/threads", {}],
  ["/api/lists/like", { username: "someone", slug: "slug", action: "like" }],
  ["/api/lists/like-external", { url: "https://trakt.tv/users/x/lists/y" }],
  ["/api/channel/like", { code: "ABCD1234" }],
  ["/api/channel/unpublish", { code: "ABCD1234" }],
  ["/api/channel/share", { channel: { name: "C", items: [] } }],
  ["/api/channel/added", { code: "ABCD1234" }],
];

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
  const user = await createUser(env, "sessiononly");
  const login = await call(env, "/api/session", { method: "POST", json: { username: user.creatorName, key: user.creatorKey } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^mla_session=/);
  return { env, user, cookie };
}

describe("SEC-03: every account route the page calls accepts the session alone", () => {
  for (const [path, extra] of ROUTES) {
    it(path, async () => {
      const { env, user, cookie } = await setup();
      const withSession = await call(env, path, { method: "POST", cookie, json: { creatorName: user.creatorName, ...extra } });
      const text = JSON.stringify(withSession.body);
      assert.notEqual(withSession.status, 401, `${path} refused a session-only request: ${text}`);
      assert.ok(!AUTH_REFUSED.test(text), `${path} did not accept the session: ${text}`);
      assert.notEqual(withSession.status, 500, text);
    });
  }

  it("the same requests without a session are refused (the session is what authenticates)", async () => {
    const { env, user } = await setup();
    for (const path of ["/api/creator/sync/load", "/api/creator/sync/save", "/api/creator/lists/save", "/api/creator/scrobble-token"]) {
      const r = await call(env, path, { method: "POST", json: { creatorName: user.creatorName, config: [] } });
      assert.ok(r.status === 401 || r.body.ok === false, `${path}: ${JSON.stringify(r.body)}`);
    }
  });
});

describe("SEC-03: the server tells the page when it may forget the key (FF_FORGET_KEY)", () => {
  async function metaHeaders(flag) {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1", ...(flag === undefined ? {} : { FF_FORGET_KEY: flag }) });
    const user = await createUser(env, "forgetflag");
    const login = await call(env, "/api/session", { method: "POST", json: { username: user.creatorName, key: user.creatorKey } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    return call(env, "/api/creator/restore", { method: "POST", cookie, json: { creatorName: user.creatorName } });
  }
  it("is off by default: no header", async () => {
    const r = await metaHeaders(undefined);
    assert.equal(r.headers.get("x-mla-session"), "forgetflag");
    assert.equal(r.headers.get("x-mla-forget-key"), null);
  });
  it("FF_FORGET_KEY=1 adds X-MLA-Forget-Key next to X-MLA-Session", async () => {
    const r = await metaHeaders("1");
    assert.equal(r.headers.get("x-mla-session"), "forgetflag");
    assert.equal(r.headers.get("x-mla-forget-key"), "1");
  });
  it("any other value leaves it off", async () => {
    assert.equal((await metaHeaders("0")).headers.get("x-mla-forget-key"), null);
  });
});
