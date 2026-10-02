const assert = require("node:assert/strict");
const { test } = require("node:test");
const sync = require("../src/cloud-sync.js");

const lib = (id, updatedAt, extra = {}) => ({ id, name: id, updatedAt, ...extra });
const file = (libraryId, updatedAt, extra = {}) => ({ fileId: `f-${libraryId}`, libraryId, name: libraryId, updatedAt, ...extra });

test("library sync: new on either side is copied across", () => {
  const plan = sync.planLibrarySync({
    local: [lib("mine", "2026-09-01T00:00:00Z")],
    remote: [file("theirs", "2026-09-01T00:00:00Z")]
  });
  assert.deepEqual(plan.download.map((f) => f.libraryId), ["theirs"]);
  assert.deepEqual(plan.upload.map((u) => [u.library.id, u.fileId]), [["mine", ""]]);
});

test("library sync: newer side wins, equal is a no-op", () => {
  const plan = sync.planLibrarySync({
    local: [
      lib("a", "2026-09-02T00:00:00Z", { driveFileId: "f-a" }),
      lib("b", "2026-09-01T00:00:00Z", { driveFileId: "f-b" }),
      lib("c", "2026-09-01T00:00:00Z", { driveFileId: "f-c" })
    ],
    remote: [file("a", "2026-09-01T00:00:00Z"), file("b", "2026-09-02T00:00:00Z"), file("c", "2026-09-01T00:00:00Z")]
  });
  assert.deepEqual(plan.upload.map((u) => [u.library.id, u.fileId]), [["a", "f-a"]]);
  assert.deepEqual(plan.download.map((f) => f.libraryId), ["b"]);
  assert.deepEqual(plan.rename, []);
  assert.deepEqual(plan.deleteLocal, []);
});

test("library sync: a rename done in Drive is adopted", () => {
  const plan = sync.planLibrarySync({
    local: [lib("a", "2026-09-01T00:00:00Z", { driveFileId: "f-a" })],
    remote: [file("a", "2026-09-01T00:00:00Z", { name: "Renamed" })]
  });
  assert.deepEqual(plan.rename, [{ id: "a", name: "Renamed", fileId: "f-a" }]);
});

test("library sync: deleted in Drive -> deleted locally; deleted locally -> trashed in Drive", () => {
  const plan = sync.planLibrarySync({
    local: [lib("gone", "2026-09-01T00:00:00Z", { driveFileId: "f-gone" })],
    remote: [file("removed-here", "2026-09-01T00:00:00Z")],
    tombstones: ["removed-here"]
  });
  assert.deepEqual(plan.deleteLocal, ["gone"]);
  assert.deepEqual(plan.trashRemote, ["f-removed-here"]);
  assert.deepEqual(plan.download, []);
});

test("library sync: duplicate or foreign files are trashed", () => {
  const plan = sync.planLibrarySync({
    local: [],
    remote: [file("a", "2026-09-02T00:00:00Z"), { ...file("a", "2026-09-01T00:00:00Z"), fileId: "dup" }, { fileId: "x", libraryId: "" }]
  });
  assert.deepEqual(plan.download.map((f) => f.fileId), ["f-a"]);
  assert.deepEqual(plan.trashRemote, ["dup", "x"]);
});

test("libraryToTsv writes one clean line per sentence", () => {
  const tsv = sync.libraryToTsv([{ id: "7", text: "Hi.\tthere", translation: "你好\n" }, { text: "Run.", translation: "" }]);
  assert.equal(tsv, "7\tHi. there\t你好\n2\tRun.\t\n");
});

test("sameDocument ignores key order, export time and identity label", () => {
  const a = { format: "langlsrw-userdata", exportedAt: 1, identity: { id: "a" }, global: { settings: { x: [1, 5] } }, languages: { en: { favoriteWord: { b: [true, 2], a: [true, 3] } } } };
  const b = { format: "langlsrw-userdata", exportedAt: 9, identity: { id: "b" }, languages: { en: { favoriteWord: { a: [true, 3], b: [true, 2] } } }, global: { settings: { x: [1, 5] } } };
  assert.equal(sync.sameDocument(a, b), true);
  assert.equal(sync.sameDocument(a, { ...b, global: { settings: { x: [2, 6] } } }), false);
  assert.equal(sync.sameDocument(a, null), false);
});
