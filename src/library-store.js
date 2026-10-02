// Per-user sentence libraries in IndexedDB (localStorage's ~5 MB is too small
// for a 30k-sentence library). For a Google user this is a cache of the TSV
// files in their Drive; for a guest it is the only copy.
//
// Record: { user, id, name, source, createdAt, updatedAt, count,
//           items: [{ id, text, translation }], driveFileId? }
(function () {
  const DB_NAME = "langLSRW";
  const STORE = "libraries";
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: ["user", "id"] });
        store.createIndex("user", "user");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("无法打开本机句库存储。"));
      };
    });
    return dbPromise;
  }

  async function run(mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("本机句库存储已满或不可用。"));
    });
  }

  function newId() {
    return `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function list(user) {
    if (!user) return [];
    const records = await run("readonly", (store) => store.index("user").getAll(user));
    return (records || []).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
  }

  function get(user, id) {
    return run("readonly", (store) => store.get([user, id]));
  }

  async function put(user, library) {
    const record = { ...library, user, count: library.items.length };
    await run("readwrite", (store) => store.put(record));
    return record;
  }

  function remove(user, id) {
    return run("readwrite", (store) => store.delete([user, id]));
  }

  async function removeAll(user) {
    const records = await list(user);
    await Promise.all(records.map((record) => remove(user, record.id)));
  }

  window.langLSRWLibraryStore = { newId, list, get, put, remove, removeAll };
})();
