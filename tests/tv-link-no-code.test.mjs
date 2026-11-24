// Audit UI-07: /tv and /link opened without ?code= showed an enabled "Link TV
// Now" button that only answered "Missing pairing code." Now the button is off
// until the visitor types the code into the box the page offers (a visitor who
// does not arrive by the TV's link must be able to enter it). With a code, nothing changes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const env = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

describe("UI-07: the TV link page without a pairing code", () => {
  for (const path of ["/tv", "/link"]) {
    it(`${path} without a code disables the button and offers a box to type the code`, async () => {
      const page = await call(env(), path);
      assert.match(page.text, /<button[^>]*id="confirmLinkBtn"[^>]*\sdisabled/);
      assert.match(page.text, /<input[^>]*id="tvCodeInput"/);
      assert.match(page.text, /Type the code shown on your TV/);
    });
    it(`${path} with a code keeps the button enabled`, async () => {
      const page = await call(env(), path + "?code=ABCD-1234");
      assert.doesNotMatch(page.text, /<button[^>]*id="confirmLinkBtn"[^>]*\sdisabled/);
      assert.doesNotMatch(page.text, /id="tvCodeInput"/);
    });
  }
});
