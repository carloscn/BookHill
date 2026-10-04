const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const read = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");

async function recovery({ bound = true } = {}) {
  const storage = new Map();
  const operations = [];
  const context = { window: { indexedDB: new IDBFactory(), addEventListener() {} },
    document: { addEventListener() {} }, Date, console, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  context.indexedDB = context.window.indexedDB;
  vm.runInNewContext(read("user-data.js"), context);
  vm.runInNewContext(read("library-store.js"), context);
  const data = context.window.langLSRWUserData;
  const libraries = context.window.langLSRWLibraryStore;
  await data.open("cloud:google-a");
  for (const scope of ["en", "es"]) {
    data.put("wordList", "words", { id: "words", name: `Words ${scope}`, words: [["hello", "你好"]] }, scope);
    data.put("passage", "reading", { id: "reading", title: `Reading ${scope}`, body: "Hello." }, scope);
    data.put("passageNote", "reading", `Notes ${scope}`, scope);
  }
  data.put("localSecrets", "aiApiKey", "private-local-key", "global");
  await data.flush();
  const legacy = data.exportDocument();
  for (const owner of ["cloud:google-a", "google:google-a"]) {
    await libraries.put(owner, { id: owner, name: owner, language: "es", driveFileId: `drive-${owner}`,
      updatedAt: "2026-09-30T12:00:00.000Z", items: [{ text: "Hola." }] });
  }
  await data.open("cloud:google-b");
  data.put("passage", "foreign", { title: "Other account", body: "Private." }, "en");
  await data.flush();
  await data.open("guest");
  Object.assign(context, { state: { cloudUser: null }, userData: data, libraryStore: libraries,
    userDataIdentity: () => context.state.cloudUser ? `idm:${context.state.cloudUser.id}` : "guest",
    idmAuth: { ready: Promise.resolve({ user: { sub: "idm-a" } }), requireGoogleLink: async () => {
      if (!bound) throw new Error("Google is not bound"); return { sub: "google-a" }; } },
    dataToCarryIntoCloud: async () => null,
    activateCloudUser: async profile => { context.state.cloudUser = { id: profile.sub }; await data.open(`idm:${profile.sub}`); },
    renderCloudAuthState: text => { if (text) operations.push(text); },
    refreshAfterUserDataChange: () => operations.push("refresh"), tryLoadDefaultLibrary: async () => {}, render() {},
    loadLibraryTombstones: owner => owner === "cloud:google-a" ? ["deleted-library"] : [],
    libraryTombstoneKey: owner => `tombstones:${owner}`,
    googleDrive: { pull: () => assert.fail("Login must not read Drive without consent"),
      signIn: () => assert.fail("Login must not open an unsolicited Google popup") } });
  const source = read("app.js");
  const start = source.indexOf("    async function migrateGoogleData(");
  const end = source.indexOf("    // Runs from the login button's click:", start);
  vm.runInNewContext(source.slice(start, end) + "globalThis.initialize = initializeCloudAuth;", context);
  await context.initialize();
  return { data, libraries, storage, operations, legacy };
}

test("verified binding recovers both languages' local word lists, passages, notes and legacy sentence libraries before Drive consent", async () => {
  const { data, libraries, storage, operations, legacy } = await recovery();
  for (const scope of ["en", "es"]) {
    assert.equal(data.get("wordList", "words", scope).name, `Words ${scope}`);
    assert.equal(data.get("passage", "reading", scope).title, `Reading ${scope}`);
    assert.equal(data.get("passageNote", "reading", scope), `Notes ${scope}`);
    assert.equal(data.exportDocument().languages[scope].passage.reading[1], legacy.languages[scope].passage.reading[1]);
  }
  assert.equal(data.get("passage", "foreign", "en"), undefined);
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), undefined);
  assert.equal((await libraries.list("idm:idm-a")).length, 2);
  assert.equal((await libraries.get("idm:idm-a", "google:google-a")).driveFileId, "drive-google:google-a");
  assert.deepEqual(JSON.parse(storage.get("tombstones:idm:idm-a")), ["deleted-library"]);
  assert.equal(storage.get("langLSRWIdmMigration:v2:idm-a:google-a"), "1");
  assert.ok(operations.some(text => text.includes("请连接 Google 云盘")));
  await data.open("cloud:google-a");
  assert.equal(data.get("passage", "reading", "es").title, "Reading es");
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), "private-local-key");
});

test("an unbound account cannot copy any previous Google user's local records", async () => {
  const { data, libraries, storage, operations } = await recovery({ bound: false });
  assert.equal(data.entries("passage", "en").length, 0);
  assert.equal(data.entries("wordList", "es").length, 0);
  assert.equal((await libraries.list("idm:idm-a")).length, 0);
  assert.equal(storage.get("langLSRWIdmMigration:v2:idm-a:google-a"), undefined);
  assert.ok(operations.includes("Google is not bound"));
});
