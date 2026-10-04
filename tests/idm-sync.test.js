const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const start = source.indexOf("    async function syncWithCloud(");
const end = source.indexOf("    function pushCloudState()", start);

async function sync(identity, { libraryError = false, storageFails = false, data = null, remote = null, uploaded = () => {} } = {}) {
  const operations = [];
  const document = remote || { format: "langlsrw-userdata", version: 2, global: {}, languages: {}, identity };
  const context = {
    state: { cloudUser: { id: "idm-a" } }, cloud: { running: null, timer: 0 }, Date, clearTimeout,
    userDataIdentity: () => "idm:idm-a", libraryOwner: () => "idm:idm-a",
    userDataIdentityMeta: () => ({ type: "idm", id: "idm-a", googleSub: "google-a" }),
    renderCloudAuthState: message => { if (message) operations.push(message); },
    idmAuth: { requireGoogleLink: async () => ({ sub: "google-a" }) },
    idmPolicy: require("../src/idm-policy.js"), cloudSync: require("../src/cloud-sync.js"),
    userData: data || { flush: async () => !storageFails, isDocument: () => true, entries: () => [],
      importDocument: () => ({ added: 0, updated: 0 }), exportDocument: meta => ({ ...document, ...meta }) },
    googleDrive: { hasToken: () => true, pull: async () => document, push: async data => { operations.push(data.identity.type); uploaded(data); } },
    migrateGoogleData: async () => operations.push("migrate"), syncLibraries: async () => {
      operations.push("libraries"); if (libraryError) throw new Error("句库文件无法读取"); return new Set(); },
    refreshAfterUserDataChange() {}, refreshLibrariesAfterSync() {}, scheduleCloudSync() {}
  };
  vm.runInNewContext(source.slice(start, end) + "globalThis.sync = syncWithCloud;", context);
  await context.sync();
  return operations;
}

test("first legacy sync stamps the IDM owner even if learning records have not changed", async () => {
  const operations = await sync({ type: "cloud", id: "google-a" });
  assert.ok(operations.includes("migrate"));
  assert.ok(operations.includes("idm"));
});

test("Drive recovery persists English/Spanish word lists, passages and notes even when a sentence file is broken", async () => {
  const storeContext = { window: { indexedDB: new IDBFactory(), addEventListener() {} },
    document: { addEventListener() {} }, Date, console, setTimeout, clearTimeout };
  storeContext.indexedDB = storeContext.window.indexedDB;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/user-data.js"), "utf8"), storeContext);
  const data = storeContext.window.langLSRWUserData;
  await data.open("idm:idm-a");
  const remote = { format: "langlsrw-userdata", version: 2, global: {},
    identity: { type: "cloud", id: "google-a" }, languages: {} };
  for (const scope of ["en", "es"]) remote.languages[scope] = {
    wordList: { words: [{ id: "words", name: `Words ${scope}`, words: [["hello", "你好"]] }, 10] },
    passage: { reading: [{ id: "reading", title: `Reading ${scope}`, body: "Hello." }, 20], gone: [null, 30, 1] },
    passageNote: { reading: [`Notes ${scope}`, 25] }
  };
  let upload;
  const operations = await sync(remote.identity, { data, remote, libraryError: true, uploaded: value => { upload = value; } });
  assert.ok(operations.some(message => message.includes("句库同步失败")));
  assert.equal(upload.identity.type, "idm");
  for (const scope of ["en", "es"]) assert.equal(upload.languages[scope].passage.gone[2], 1);
  await data.open("guest");
  await data.open("idm:idm-a");
  for (const scope of ["en", "es"]) {
    assert.equal(data.get("wordList", "words", scope).name, `Words ${scope}`);
    assert.equal(data.get("passage", "reading", scope).title, `Reading ${scope}`);
    assert.equal(data.get("passageNote", "reading", scope), `Notes ${scope}`);
  }
});

test("personal data completes before a sentence-library failure, and reports partial sync", async () => {
  const operations = await sync({ type: "cloud", id: "google-a" }, { libraryError: true });
  assert.ok(operations.indexOf("idm") < operations.indexOf("libraries"));
  assert.ok(operations.some(message => message.includes("词表、课文和学习记录已同步；句库同步失败")));
  assert.equal(operations.some(message => message.startsWith("已同步")), false);
});

test("failed local persistence stops before cloud upload or sentence-library changes", async () => {
  const operations = await sync({ type: "cloud", id: "google-a" }, { storageFails: true });
  assert.equal(operations.includes("idm"), false);
  assert.equal(operations.includes("libraries"), false);
  assert.ok(operations.some(message => message.includes("尚未保存到本机")));
});

test("foreign IDM cloud documents stop sync before migration or any library write", async () => {
  const operations = await sync({ type: "idm", id: "idm-b", googleSub: "google-a" });
  assert.equal(operations.includes("migrate"), false);
  assert.equal(operations.includes("libraries"), false);
  assert.equal(operations.includes("idm"), false);
  assert.ok(operations.some(message => message.includes("其他账户")));
});
