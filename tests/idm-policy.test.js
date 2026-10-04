const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/idm-policy.js");

test("Google binding belongs to the authenticated IDM subject, never an email match", () => {
  const binding = { sub: "idm-a", google: { sub: "google-a", email: "same@example.com" } };
  assert.equal(policy.linkedSubject(binding, "idm-a"), "google-a");
  assert.equal(policy.linkedSubject(binding, "idm-b"), "");
  assert.equal(policy.linkedSubject({ sub: "idm-a", google: null }, "idm-a"), "");
  assert.equal(policy.linkedSubject(null, undefined), "");
});

test("migrate only a matching legacy Google document or the same IDM/Google pair", () => {
  assert.equal(policy.acceptsDocument(null, "idm-a", "google-a"), true);
  assert.equal(policy.acceptsDocument({ identity: { type: "cloud", id: "google-a" } }, "idm-a", "google-a"), true);
  assert.equal(policy.acceptsDocument({ identity: { type: "idm", id: "idm-a", googleSub: "google-a" } }, "idm-a", "google-a"), true);
  for (const identity of [undefined, { type: "cloud", id: "google-b" }, { type: "local", name: "same@example.com" },
    { type: "idm", id: "idm-b", googleSub: "google-a" }, { type: "idm", id: "idm-a", googleSub: "google-b" }]) {
    assert.equal(policy.acceptsDocument({ identity }, "idm-a", "google-a"), false);
  }
});
