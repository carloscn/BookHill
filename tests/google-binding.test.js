const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/google-drive.js"), "utf8");

function browser({ linked = "google-a", selected = "google-a", scope = "openid https://www.googleapis.com/auth/drive.file" } = {}) {
  let owner = "idm-a";
  const requests = [];
  const storage = new Map();
  const context = { Date, URL, URLSearchParams, Blob, console,
    document: { querySelector: () => ({ content: "public-client" }) },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("userinfo")) return { ok: true, json: async () => ({ sub: selected, email: "user@example.com" }) };
      return { ok: true, json: async () => ({ files: [] }) };
    },
    window: { langLSRWIdmAuth: {
      user: () => owner ? { sub: owner } : null,
      requireGoogleLink: async () => { if (!linked) throw new Error("not bound"); return { sub: linked }; }
    }, google: { accounts: { oauth2: { initTokenClient: config => ({
      requestAccessToken: () => config.callback({ access_token: "google-token", expires_in: 3600, scope })
    }) } } } }
  };
  vm.runInNewContext(source, context);
  return { drive: context.window.langLSRWGoogleDrive, requests, unbind: () => { linked = ""; },
    switchUser: () => { owner = "idm-b"; } };
}

test("unbound IDM user cannot obtain a Google token or touch Drive", async () => {
  const b = browser({ linked: "" });
  await assert.rejects(b.drive.signIn(), /not bound/);
  assert.equal(b.requests.length, 0);
  assert.equal(b.drive.hasToken(), false);
});

test("wrong Google account and denied Drive scope fail before any Drive request", async () => {
  for (const options of [{ selected: "google-b" }, { scope: "openid email" }]) {
    const b = browser(options);
    await assert.rejects(b.drive.signIn());
    assert.equal(b.drive.hasToken(), false);
    assert.equal(b.requests.filter(r => !r.url.endsWith("userinfo")).length, 0);
  }
});

test("valid binding works; unlinking prevents subsequent Drive requests", async () => {
  const b = browser();
  await b.drive.signIn();
  assert.equal(b.drive.hasToken(), true);
  b.unbind();
  await assert.rejects(b.drive.pull(), /not bound/);
  assert.equal(b.requests.length, 1);
});

test("switching IDM users invalidates even an unexpired Google token", async () => {
  const b = browser();
  await b.drive.signIn();
  b.switchUser();
  assert.equal(b.drive.hasToken(), false);
  await assert.rejects(b.drive.pull(), /连接已过期/);
  assert.equal(b.drive.hasToken(), false);
});
