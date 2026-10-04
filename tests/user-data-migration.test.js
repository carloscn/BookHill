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
  for (const language of ["en", "es"]) {
    data.put("wordList", "my-words", { id: "my-words", name: "My words", words: [[language === "en" ? "hello" : "hola", "你好"]] }, language);
    data.put("passage", "my-reading", { id: "my-reading", title: "My reading", body: language === "en" ? "Hello world." : "Hola mundo." }, language);
    data.put("passageNote", "my-reading", `Notes: ${language}`, language);
    data.put("passage", "deleted-reading", { title: "Deleted", body: "Gone." }, language);
    data.remove("passage", "deleted-reading", language);
  }
  data.put("settings", "learningLanguage", "es", "global");
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
  for (const language of ["en", "es"]) {
    assert.equal(data.get("wordList", "my-words", language).words.length, 1);
    assert.equal(data.get("passage", "my-reading", language).title, "My reading");
    assert.equal(data.get("passageNote", "my-reading", language), `Notes: ${language}`);
    assert.equal(data.get("passage", "deleted-reading", language), undefined);
    assert.equal(data.exportDocument().languages[language].passage["deleted-reading"][2], 1);
  }
  assert.equal(data.get("settings", "learningLanguage", "global"), "es");
  const stale = { format: "langlsrw-userdata", version: 2, global: {}, languages: { en: { passage: {
    "deleted-reading": [{ title: "Old copy", body: "Must stay deleted." }, legacy.languages.en.passage["deleted-reading"][1] - 1]
  } } } };
  data.importDocument(stale);
  assert.equal(data.get("passage", "deleted-reading", "en"), undefined);
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), undefined);
  await data.open("cloud:google-a");
  assert.equal(data.get("favoriteWord", "hello", "en").w, "hello");
  assert.equal(data.get("localSecrets", "aiApiKey", "global"), "encrypted-secret");
});

test("first opening an identity reads defaults without stamping over old/cloud language settings", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const start = source.indexOf("    function applyIdentitySettings()");
  const end = source.indexOf("    // 练习 settings:", start);
  const language = [];
  const context = { LEARNING_LANGUAGES: { en: {}, es: {} }, defaultShortcuts: {}, state: {},
    userData: { get: () => undefined, put: () => assert.fail("Reading defaults must not write newer settings") },
    defaultSettingValue: name => name === "theme" ? { mode: "system", palette: "default" } : {},
    setLearningLanguage: value => language.push(value), document: { querySelectorAll: () => [] } };
  for (const name of ["applyTheme", "applyFontSettings", "applyGrammarColors", "loadAiSettings", "restoreAiKey",
    "loadPracticeSettings", "loadSpeechSettings", "populateVoices", "renderShortcutSettings", "updateSpeechRateIndicator"]) context[name] = () => {};
  vm.runInNewContext(source.slice(start, end) + "globalThis.apply = applyIdentitySettings;", context);
  context.apply();
  context.userData.get = (_collection, name) => name === "learningLanguage" ? "es" : undefined;
  context.apply();
  assert.deepEqual(language, ["en", "es"]);
});
