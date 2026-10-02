// Google Drive sync rules. Pure functions, no DOM or network, so they run under node (tests/cloud-sync.test.js).
//
// langLSRW/langlsrw-userdata.json   the identity's personal data document (src/user-data.js exportDocument);
//                                   records merge one by one, newer wins, via userData.importDocument.
// langLSRW/libraries/*.tsv          one file per sentence library; see planLibrarySync.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.langLSRWCloudSync = api;
})(typeof self !== "undefined" ? self : this, function () {
  function time(value) {
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Reconcile local libraries with the TSV files in Drive.
  //   local:      [{ id, name, updatedAt, driveFileId }]
  //   remote:     [{ fileId, libraryId, name, updatedAt }]  (non-trashed files)
  //   tombstones: library ids deleted locally since the last sync
  // A library that was synced before (has driveFileId) but is gone from Drive
  // was deleted there by the user, so it is deleted locally too.
  function planLibrarySync({ local = [], remote = [], tombstones = [] } = {}) {
    const plan = { download: [], upload: [], rename: [], deleteLocal: [], trashRemote: [] };
    const deleted = new Set(tombstones);
    const localById = new Map(local.map((library) => [library.id, library]));
    const seen = new Set();

    remote.forEach((file) => {
      if (!file.libraryId || deleted.has(file.libraryId) || seen.has(file.libraryId)) {
        plan.trashRemote.push(file.fileId);
        return;
      }
      seen.add(file.libraryId);
      const library = localById.get(file.libraryId);
      if (!library) {
        plan.download.push(file);
      } else if (time(file.updatedAt) > time(library.updatedAt)) {
        plan.download.push(file);
      } else if (time(library.updatedAt) > time(file.updatedAt)) {
        plan.upload.push({ library, fileId: file.fileId });
      } else if (file.name && file.name !== library.name) {
        plan.rename.push({ id: library.id, name: file.name, fileId: file.fileId });
      } else if (library.driveFileId !== file.fileId) {
        plan.rename.push({ id: library.id, name: library.name, fileId: file.fileId });
      }
    });

    local.forEach((library) => {
      if (seen.has(library.id)) return;
      if (library.driveFileId) plan.deleteLocal.push(library.id);
      else plan.upload.push({ library, fileId: "" });
    });
    return plan;
  }

  // Library file <-> TSV text. One sentence per line: id, English, translation.
  function libraryToTsv(items) {
    const clean = (value) => String(value || "").replace(/[\t\r\n]+/g, " ").trim();
    return items.map((item, index) => [clean(item.id) || String(index + 1), clean(item.text), clean(item.translation)].join("\t")).join("\n") + "\n";
  }

  // JSON with sorted object keys, so two documents with the same records compare equal.
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  // True when two personal data documents hold the same records (export time and identity label ignored),
  // so a sync with nothing new skips the upload.
  function sameDocument(a, b) {
    if (!a || !b) return false;
    return canonical({ global: a.global, languages: a.languages }) === canonical({ global: b.global, languages: b.languages });
  }

  return { planLibrarySync, libraryToTsv, sameDocument };
});
