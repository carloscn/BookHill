const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const start = source.indexOf("    async function syncWithCloud(");
const end = source.indexOf("    function pushCloudState()", start);

async function sync(identity) {
  const operations = [];
  const document = { format: "langlsrw-userdata", version: 2, global: {}, languages: {}, identity };
  const context = {
    state: { cloudUser: { id: "idm-a" } }, cloud: { running: null, timer: 0 }, Date, clearTimeout,
    userDataIdentity: () => "idm:idm-a", libraryOwner: () => "idm:idm-a",
    userDataIdentityMeta: () => ({ type: "idm", id: "idm-a", googleSub: "google-a" }),
    renderCloudAuthState: message => { if (message) operations.push(message); },
    idmAuth: { requireGoogleLink: async () => ({ sub: "google-a" }) },
    idmPolicy: require("../src/idm-policy.js"), cloudSync: require("../src/cloud-sync.js"),
    userData: { flush: async () => true, isDocument: () => true,
      importDocument: () => ({ added: 0, updated: 0 }), exportDocument: meta => ({ ...document, ...meta }) },
    googleDrive: { hasToken: () => true, pull: async () => document, push: async data => operations.push(data.identity.type) },
    migrateGoogleData: async () => operations.push("migrate"), syncLibraries: async () => { operations.push("libraries"); return new Set(); },
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

test("foreign IDM cloud documents stop sync before migration or any library write", async () => {
  const operations = await sync({ type: "idm", id: "idm-b", googleSub: "google-a" });
  assert.equal(operations.includes("migrate"), false);
  assert.equal(operations.includes("libraries"), false);
  assert.equal(operations.includes("idm"), false);
  assert.ok(operations.some(message => message.includes("其他账户")));
});
