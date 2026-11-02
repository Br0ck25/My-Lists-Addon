// SEC-05: the voter id kept for a signed-out like was a bare SHA-256 of
// "ip|scope" cut to 128 bits. IPv4 has only 2^32 addresses, so the address
// behind any stored vote could be recovered by trying them all. With a secret
// pepper (LIKE_VOTER_PEPPER, or LOOKUP_PEPPER when that one is set) the id is
// an HMAC and cannot be reversed without the secret. Without a pepper nothing
// changes. Signed-out likes themselves are retired (D-6): every route passes an
// account name, so this path is not reached today; the stored "a:" ids of
// votes cast before D-6 are untouched (D-9).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sb = { console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder, Response, Headers, Request, crypto: globalThis.crypto };
sb.globalThis = sb;
vm.createContext(sb);
for (const f of ["src/core/00_constants.js", "src/core/02_http-and-creator-utils.js", "src/api/32_likes-api.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sb, { filename: f });
}

const req = (ip) => new Request("https://example.test/x", { headers: { "CF-Connecting-IP": ip } });
const legacyId = async (ip, scope) => "a:" + (await sb.hashStringForKey(`${sb.clientIpKey(req(ip))}|${scope}`));

describe("SEC-05: anonymous like voter ids", () => {
  it("without a pepper the id is exactly today's", async () => {
    const id = await sb.likeVoterId(req("203.0.113.9"), {}, "", "alice:list");
    assert.equal(id, await legacyId("203.0.113.9", "alice:list"));
  });

  it("with LIKE_VOTER_PEPPER the id is not the SHA-256 of ip|scope, is stable, and differs per IP and scope", async () => {
    const env = { LIKE_VOTER_PEPPER: "a-long-secret-pepper-for-like-voter-ids" };
    const id = await sb.likeVoterId(req("203.0.113.9"), env, "", "alice:list");
    assert.match(id, /^a:[0-9a-f]{32}$/);
    assert.notEqual(id, await legacyId("203.0.113.9", "alice:list"), "a database copy can no longer be reversed by trying every IP");
    assert.equal(id, await sb.likeVoterId(req("203.0.113.9"), env, "", "alice:list"));
    assert.notEqual(id, await sb.likeVoterId(req("203.0.113.10"), env, "", "alice:list"));
    assert.notEqual(id, await sb.likeVoterId(req("203.0.113.9"), env, "", "alice:other"));
  });

  it("a different pepper gives a different id, and LOOKUP_PEPPER is used when there is no LIKE_VOTER_PEPPER", async () => {
    const a = await sb.likeVoterId(req("203.0.113.9"), { LIKE_VOTER_PEPPER: "pepper-one-pepper-one-pepper-one" }, "", "s");
    const b = await sb.likeVoterId(req("203.0.113.9"), { LIKE_VOTER_PEPPER: "pepper-two-pepper-two-pepper-two" }, "", "s");
    const c = await sb.likeVoterId(req("203.0.113.9"), { LOOKUP_PEPPER: "pepper-one-pepper-one-pepper-one" }, "", "s");
    assert.notEqual(a, b);
    assert.equal(a, c, "LOOKUP_PEPPER stands in when LIKE_VOTER_PEPPER is unset");
  });

  it("a signed-in voter is still u:<name>, whatever the pepper", async () => {
    assert.equal(await sb.likeVoterId(req("203.0.113.9"), { LIKE_VOTER_PEPPER: "x".repeat(32) }, "alice", "s"), "u:alice");
  });
});
