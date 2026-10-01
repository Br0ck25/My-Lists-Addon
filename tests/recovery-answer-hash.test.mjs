// Recovery answers get six times the hashing work (P7-4; hashRecoveryAnswer,
// 02_). Workers refuse a PBKDF2 call over 100,000 iterations, so the 600,000
// the plan asked for are six chained rounds of 100,000. Answers stored the old
// way keep working and are rehashed the next time they are used correctly.
// Creator Keys are generated (~60 random bits) and stay at one round.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { call, createUser, makeD1, makeEnv } from "./harness.mjs";

const NEW_SHAPE = /^pbkdf2x:6:100000:[0-9a-f]{32}:[0-9a-f]{64}$/;

// An answer hashed the way every account before P7-4 has it.
async function legacyHash(answer) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(answer), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await webcrypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256));
  const hex = (b) => Buffer.from(b).toString("hex");
  return `pbkdf2:100000:${hex(salt)}:${hex(bits)}`;
}

// Every copy of the stored answer: the KV profile, D1's creators row and the
// accounts mirror.
async function storedAnswers(env, username) {
  const profile = JSON.parse(await env.CONFIGS.get(`creator:${username}`));
  const creators = env.DB._db.prepare("SELECT recovery_answer_hash AS h FROM creators WHERE username = ?").get(username);
  const account = env.DB._db.prepare("SELECT recovery_answer_hash AS h FROM accounts WHERE username = ? COLLATE NOCASE").get(username);
  return { kv: profile.recoveryAnswerHash, creators: creators && creators.h, account: account && account.h };
}

// An account whose answer was set before P7-4, in every store.
async function legacyAccount(name, answer) {
  const env = makeEnv({ DB: makeD1() });
  const user = await createUser(env, name, { recoveryAnswer: answer });
  // The accounts mirror row exists once the account has signed in.
  await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey } });
  const old = await legacyHash(answer.toLowerCase());
  const profile = JSON.parse(await env.CONFIGS.get(`creator:${user.creatorName}`));
  await env.CONFIGS.put(`creator:${user.creatorName}`, JSON.stringify({ ...profile, recoveryAnswerHash: old }));
  env.DB._db.prepare("UPDATE creators SET recovery_answer_hash = ? WHERE username = ?").run(old, user.creatorName);
  env.DB._db.prepare("UPDATE accounts SET recovery_answer_hash = ? WHERE username = ? COLLATE NOCASE").run(old, user.creatorName);
  return { env, user, old };
}

describe("recovery answers (P7-4)", () => {
  it("are stored with six rounds of 100,000 iterations, and still reset the key", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "rahnew", { recoveryAnswer: "Purple Elephant" });
    const stored = await storedAnswers(env, user.creatorName);
    assert.match(stored.kv, NEW_SHAPE);
    assert.equal(stored.creators, stored.kv);

    const reset = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: user.creatorName, recoveryAnswer: "purple elephant " } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.ok, true);
  });

  it("an answer stored the old way still resets the key, and is rehashed in every store", async () => {
    const { env, user, old } = await legacyAccount("rahold", "green lantern");
    const wrong = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: user.creatorName, recoveryAnswer: "blue lantern" } });
    assert.equal(wrong.status, 401);
    assert.equal((await storedAnswers(env, user.creatorName)).kv, old, "a wrong answer upgrades nothing");

    const reset = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: user.creatorName, recoveryAnswer: "Green Lantern" } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const after = await storedAnswers(env, user.creatorName);
    assert.match(after.kv, NEW_SHAPE);
    assert.equal(after.creators, after.kv);
    assert.equal(after.account, after.kv);

    // The new key works, and so does the answer, now in its new shape.
    const signIn = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: user.creatorName, creatorKey: reset.body.creatorKey } });
    assert.equal(signIn.status, 200);
    const again = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: user.creatorName, recoveryAnswer: "green lantern" } });
    assert.equal(again.status, 200);
  });

  it("forgot-username rehashes an old answer it has just checked", async () => {
    const { env, user } = await legacyAccount("rahforgot", "silver surfer");
    const r = await call(env, "/api/creator/forgot-username", { method: "POST", json: { creatorKey: user.creatorKey, recoveryAnswer: "silver surfer" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.username, user.creatorName);
    assert.match((await storedAnswers(env, user.creatorName)).kv, NEW_SHAPE);
  });

  it("setting a new answer stores the new shape", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "rahset");
    const r = await call(env, "/api/creator/recovery-answer", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey, recoveryAnswer: "a long answer" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = await storedAnswers(env, user.creatorName);
    assert.match(stored.kv, NEW_SHAPE);
    assert.equal(stored.creators, stored.kv);
  });

  it("leaves the Account Key at one round, so a sign-in check costs what it did", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "rahkey");
    const profile = JSON.parse(await env.CONFIGS.get(`creator:${user.creatorName}`));
    assert.match(profile.keyHash, /^pbkdf2:100000:/);
  });

  it("refuses a stored value that asks for more work than it may", async () => {
    const { env, user } = await legacyAccount("rahbound", "bounded answer");
    const huge = "pbkdf2x:500:100000:" + "00".repeat(16) + ":" + "00".repeat(32);
    const profile = JSON.parse(await env.CONFIGS.get(`creator:${user.creatorName}`));
    await env.CONFIGS.put(`creator:${user.creatorName}`, JSON.stringify({ ...profile, recoveryAnswerHash: huge }));
    env.DB._db.prepare("UPDATE creators SET recovery_answer_hash = ? WHERE username = ?").run(huge, user.creatorName);
    const started = Date.now();
    const r = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: user.creatorName, recoveryAnswer: "bounded answer" } });
    assert.equal(r.status, 401);
    assert.ok(Date.now() - started < 5000, "answered without running 500 rounds");
  });
});
