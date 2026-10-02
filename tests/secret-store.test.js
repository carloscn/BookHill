const assert = require("node:assert/strict");
const { test } = require("node:test");
const secrets = require("../src/secret-store.js");

const context = { user: "google:123", origin: "https://api.openai.com" };
const apiKey = "sk-proj-abcdefghijklmnop1234";

test("device key: round trip, and the key cannot be exported", async () => {
  const key = await secrets.generateDeviceKey();
  assert.equal(key.extractable, false);
  const box = await secrets.encrypt(key, apiKey, context);
  assert.ok(!box.data.includes("abcdef"), "ciphertext does not contain the key");
  assert.equal(await secrets.decrypt(key, box, context), apiKey);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", key));
});

test("ciphertext is bound to the user and the API origin", async () => {
  const key = await secrets.generateDeviceKey();
  const box = await secrets.encrypt(key, apiKey, context);
  await assert.rejects(() => secrets.decrypt(key, box, { ...context, user: "Guest" }), /无法解密/);
  await assert.rejects(() => secrets.decrypt(key, box, { ...context, origin: "https://evil.example" }), /无法解密/);
  const otherDevice = await secrets.generateDeviceKey();
  await assert.rejects(() => secrets.decrypt(otherDevice, box, context), /无法解密/);
});

test("passphrase: round trip, wrong password rejected, fresh salt each time", async () => {
  const box = await secrets.sealWithPassphrase("correct horse", apiKey, context);
  assert.equal(box.iterations, secrets.PBKDF2_ITERATIONS);
  assert.equal(await secrets.openWithPassphrase("correct horse", box, context), apiKey);
  await assert.rejects(() => secrets.openWithPassphrase("wrong horse", box, context), /无法解密/);
  const again = await secrets.sealWithPassphrase("correct horse", apiKey, context);
  assert.notEqual(again.salt, box.salt);
  assert.notEqual(again.data, box.data);
});

test("base URL must be https (http only for this machine)", () => {
  assert.deepEqual(secrets.checkBaseUrl("https://api.openai.com/v1/"), { ok: true, origin: "https://api.openai.com", baseUrl: "https://api.openai.com/v1" });
  assert.equal(secrets.checkBaseUrl("http://localhost:11434/v1").ok, true);
  assert.equal(secrets.checkBaseUrl("http://api.example.com/v1").ok, false);
  assert.equal(secrets.checkBaseUrl("ftp://api.example.com").ok, false);
  assert.equal(secrets.checkBaseUrl("https://user:pass@api.example.com").ok, false);
  assert.equal(secrets.checkBaseUrl("not a url").ok, false);
});

test("key hint shows only a prefix and the last four characters", () => {
  assert.equal(secrets.keyHint("sk-proj-abcdefghijklmnop1234"), "sk-proj-…1234");
  assert.equal(secrets.keyHint("sk-abcdefghijklmnop9876"), "sk-…9876");
  assert.equal(secrets.keyHint("AIzaSyExampleKey5678"), "…5678");
  assert.equal(secrets.keyHint("short"), "••••");
});
