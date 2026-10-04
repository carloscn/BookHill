const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");

test("legacy Google records migrate across both languages without secrets, losing tombstones or changing the old identity", async () => {
  const context = { window: { indexedDB: new IDBFactory(), addEventListener() {} },
    document: { addEventListener() {} }, Date, console, setTimeout, clearTimeout };
  context.indexedDB = context.window.indexedDB;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/user-data.js"), "utf8"), context);
  const data = context.window.langLSRWUserData;
  await data.open("cloud:google-a");
  data.put("favoriteWord", "hello", { w: "hello" }, "en");
  data.put("favoriteWord", "hola", { w: "hola" }, "es");
  data.put("localSecrets", "aiApiKey", "encrypted-secret", "global");
  data.put("favoriteWord", "deleted", { w: "deleted" }, "en");
  data.remove("favoriteWord", "deleted", "en");
  await data.flush();
  await data.open("idm:idm-a");
  const legacy = await data.exportIdentity("cloud:google-a");
  assert.equal(data.identity, "idm:idm-a");
  assert.equal(legacy.global.localSecrets, undefined);
  assert.equal(legacy.languages.en.favoriteWord.deleted[2], 1);
  data.importDocument(legacy);
  await data.flush();
  assert.equal(data.get("favoriteWord", "hello", "en").w, "hello");
  assert.equal(data.get("favoriteWord", "hola", "es").w, "hola");
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), undefined);
  await data.open("cloud:google-a");
  assert.equal(data.get("favoriteWord", "hello", "en").w, "hello");
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), "encrypted-secret");
});
