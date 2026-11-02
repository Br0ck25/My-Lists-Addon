// traktHeaders is the one place the Trakt request header block is written
// (CQ-05). Every call site that used to spell it out now gets it from here, so
// this pins the exact set of keys and values Trakt is sent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT, "src/core/03_trakt-headers.js"), "utf8");
const m = src.match(/function traktHeaders\([\s\S]*?\n}\n/);
assert.ok(m, "traktHeaders is defined at the top level of 03_trakt-headers.js");
const sandbox = { ADDON_VERSION: "9.9.9", TRAKT_CLIENT_ID: "site-id" };
vm.createContext(sandbox);
vm.runInContext(m[0], sandbox);
const headers = (...a) => JSON.parse(JSON.stringify(sandbox.traktHeaders(...a)));

describe("traktHeaders", () => {
  it("sends exactly the five Trakt headers when signed in", () => {
    assert.deepEqual(headers("tok"), {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": "site-id",
      Authorization: "Bearer tok",
      "User-Agent": "my-list-addon/9.9.9",
    });
  });
  it("leaves Authorization out when there is no token", () => {
    for (const none of [undefined, null, ""]) assert.equal("Authorization" in headers(none), false);
  });
  it("uses the person's own app id when one is passed, the site's otherwise", () => {
    assert.equal(headers("tok", "own-id")["trakt-api-key"], "own-id");
    assert.equal(headers("tok")["trakt-api-key"], "site-id");
  });
  it("reads the site app id when called, not when defined", () => {
    sandbox.TRAKT_CLIENT_ID = "later-id";
    assert.equal(headers("tok")["trakt-api-key"], "later-id");
  });
});
