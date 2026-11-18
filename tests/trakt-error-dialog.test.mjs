// API-03: the Trakt error dialog must not show wording taken from the address
// bar, and must not call every exchange failure a Cloudflare rate limit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

function open(search) {
  const client = loadClient();
  const alerts = [];
  const timers = [];
  client.set("showAppAlert", (title, msg) => alerts.push({ title, msg }));
  client.set("showToast", (msg) => alerts.push({ title: "toast", msg }));
  client.set("startTraktDeviceLogin", () => timers.push("device"));
  client.set("setTimeout", (fn) => { fn(); return 0; });
  client.location.search = search;
  client.call("pickUpTraktTokenFromUrl");
  return { alerts, timers };
}

describe("Trakt error dialog (API-03)", () => {
  it("never shows text a link supplied", () => {
    const { alerts } = open("?trakt_error=Security%20alert&trakt_error_detail=Call%20support%20on%200800");
    assert.equal(alerts.length, 1);
    assert.ok(!/Security alert|0800|support/i.test(alerts[0].msg), alerts[0].msg);
    assert.match(alerts[0].msg, /Could not connect to Trakt/);
  });

  it("an exchange failure is not blamed on Cloudflare unless the detail says so", () => {
    const { alerts, timers } = open("?trakt_error=exchange_failed&trakt_error_detail=invalid_grant");
    assert.ok(!/Cloudflare|1015/.test(alerts[0].msg), alerts[0].msg);
    assert.deepEqual(timers, []);
  });

  it("a real 1015 still falls back to the device-code login", () => {
    const { alerts, timers } = open("?trakt_error=exchange_failed&trakt_error_detail=error%201015");
    assert.match(alerts[0].msg, /Cloudflare/);
    assert.deepEqual(timers, ["device"]);
  });

  it("keeps the fixed wording for known codes", () => {
    const { alerts } = open("?trakt_error=access_denied");
    assert.match(alerts[0].msg, /cancelled/);
  });
});
