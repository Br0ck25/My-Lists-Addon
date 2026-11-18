// CQ-05: the server and the builder page are separate scopes, so these three
// numbers are typed in both. The comments say "the two have to agree"; this is
// the test that makes them. A mismatch means the page shows one cap while the
// server enforces another.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (dir) => readdirSync(new URL(`../src/${dir}/`, import.meta.url))
  .map((f) => readFileSync(new URL(`../src/${dir}/${f}`, import.meta.url), "utf8")).join("\n");
const SERVER = ["core", "catalog", "api"].map(read).join("\n");
const CLIENT = read("client");
const valueOf = (src, name) => {
  const m = [...src.matchAll(new RegExp(`^const ${name} = (\\d+);`, "gm"))];
  assert.equal(m.length, 1, `${name} should be declared exactly once, found ${m.length}`);
  return Number(m[0][1]);
};

for (const name of ["CHANNEL_POOL_MAX_ITEMS", "CHANNEL_ROTATION_SHOWS_PER_DAY", "CHANNEL_ROTATION_EPISODES_PER_SHOW"]) {
  test(`${name} is the same number on the server and on the page`, () => {
    assert.equal(valueOf(CLIENT, name), valueOf(SERVER, name));
  });
}
