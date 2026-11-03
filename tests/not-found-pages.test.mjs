// UI-07: a person who follows a dead link gets a page with a way back, not raw
// JSON or a bare "Not found". Feeds and the API keep their JSON/plain answers:
// Stremio/Nuvio fetch /lists/<user>/<slug>.json and must still read an error.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

const NAV = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };

describe("not-found answers for people", () => {
  it("a browser opening a dead shared list link gets an HTML page with a link home", async () => {
    const res = await call(makeEnv(), "/lists/nobody/nothing", { headers: NAV });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(res.text, /href="\/"/);
    assert.doesNotMatch(res.text, /"ok":false/);
  });

  it("an unknown address in a browser gets an HTML page with a link home", async () => {
    const res = await call(makeEnv(), "/foo", { headers: NAV });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(res.text, /href="\/"/);
  });

  it("the .json feed of a dead list is still JSON", async () => {
    const res = await call(makeEnv(), "/lists/nobody/nothing.json", { headers: NAV });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal(JSON.parse(res.text).ok, false);
  });

  it("an app (no browser navigation) gets JSON for a dead list and plain text for an unknown address", async () => {
    const env = makeEnv();
    const a = await call(env, "/lists/nobody/nothing");
    assert.match(a.headers.get("content-type") || "", /application\/json/);
    const b = await call(env, "/foo");
    assert.equal(b.status, 404);
    assert.match(b.headers.get("content-type") || "", /text\/plain/);
  });

  it("/api/* stays JSON/plain even for a browser", async () => {
    const res = await call(makeEnv(), "/api/does-not-exist", { headers: NAV });
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get("content-type") || "", /text\/html/);
  });
});
