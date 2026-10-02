(() => {
  // The site serves no dictionary data: users download a package from the GitHub release below and install it
  // from the file. Metadata mirrors what tools/build-*.py wrote into each package's dictionary_meta.
  const DICTIONARY_RELEASE_URL = "https://github.com/carloscn/BookHill/releases/tag/dictionaries-2026.10";
  const DICTIONARY_DOWNLOAD_BASE = "https://github.com/carloscn/BookHill/releases/download/dictionaries-2026.10/";
  const DICTIONARY_PACKAGES = {
    ecdict: {
      id: "ecdict",
      languageId: "en",
      label: "英语",
      databaseName: "/ecdict.sqlite",
      testWord: "dictionary",
      manifest: {
        schemaVersion: 1,
        id: "ecdict",
        name: "ECDICT 英汉词典",
        version: "2026.09.24",
        file: "ecdict.sqlite.gz",
        entryCount: 770611,
        databaseBytes: 178720768,
        downloadBytes: 71124602,
        license: "MIT"
      }
    },
    "spanish-wiktionary": {
      id: "spanish-wiktionary",
      languageId: "es",
      label: "西语",
      databaseName: "/spanish-wiktionary.sqlite",
      testWord: "gratis",
      manifest: {
        schemaVersion: 1,
        id: "spanish-wiktionary",
        name: "西语 Wiktionary 词典",
        version: "2026.09.27",
        file: "spanish-wiktionary.sqlite.gz",
        entryCount: 770716,
        databaseBytes: 437243904,
        downloadBytes: 70438772,
        license: "CC BY-SA 4.0"
      }
    }
  };

  class DictionaryService {
    constructor(options = {}) {
      this.packages = options.packages || DICTIONARY_PACKAGES;
      this.activeDictionaryId = options.activeDictionaryId || "ecdict";
      this.workerUrl = options.workerUrl || "src/dictionary/dictionary-worker.js?v=20261002-2";
      this.worker = null;
      this.sequence = 0;
      this.pending = new Map();
      this.progressListeners = new Set();
      this.manifests = new Map();
    }

    ensureWorker() {
      if (this.worker) return;
      this.worker = new Worker(this.workerUrl, { type: "module" });
      this.worker.addEventListener("message", (event) => {
        if (event.data?.type === "progress") {
          this.progressListeners.forEach((listener) => listener(event.data));
          return;
        }
        const task = this.pending.get(event.data?.id);
        if (!task) return;
        this.pending.delete(event.data.id);
        if (event.data.error) task.reject(new Error(event.data.error));
        else task.resolve(event.data.result);
      });
      this.worker.addEventListener("error", (event) => {
        const error = new Error(event.message || "词典 Worker 启动失败");
        this.pending.forEach((task) => task.reject(error));
        this.pending.clear();
      });
    }

    call(method, payload) {
      this.ensureWorker();
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, method, payload });
      });
    }

    dictionary(id = this.activeDictionaryId) {
      const dictionary = this.packages[id];
      if (!dictionary) throw new Error(`未知词典：${id}`);
      return dictionary;
    }

    listPackages() {
      return Object.values(this.packages);
    }

    setActiveDictionary(id) {
      this.dictionary(id);
      this.activeDictionaryId = id;
    }

    activeDictionary() {
      return this.dictionary(this.activeDictionaryId);
    }

    async loadManifest(id = this.activeDictionaryId) {
      return this.dictionary(id).manifest;
    }

    downloadUrl(id = this.activeDictionaryId) {
      return DICTIONARY_DOWNLOAD_BASE + this.dictionary(id).manifest.file;
    }

    releaseUrl() {
      return DICTIONARY_RELEASE_URL;
    }

    workerDictionary(id = this.activeDictionaryId) {
      const dictionary = this.dictionary(id);
      return {
        id: dictionary.id,
        languageId: dictionary.languageId,
        databaseName: dictionary.databaseName
      };
    }

    // Spanish frequency ranks are embedded in the package (langlsrw_frequency); nothing is fetched at runtime.
    async frequencyOptions() {
      return null;
    }

    async status(id = this.activeDictionaryId) {
      const [manifest, installed] = await Promise.all([
        this.loadManifest(id),
        this.call("status", { dictionary: this.workerDictionary(id) })
      ]);
      const currentVersion = installed.metadata?.dictionary_version;
      return {
        ...installed,
        manifest,
        package: this.dictionary(id),
        updateAvailable: Boolean(installed.installed && currentVersion && currentVersion !== manifest.version)
      };
    }

    async statuses() {
      const entries = await Promise.all(this.listPackages().map((dictionary) => (
        this.status(dictionary.id).catch((error) => ({ package: dictionary, error }))
      )));
      return entries;
    }

    // `file` is the package the user downloaded (.sqlite.gz, or an uncompressed .sqlite).
    async install(id = this.activeDictionaryId, file) {
      if (!(file instanceof Blob)) throw new Error("请选择下载好的词典文件");
      const dictionary = this.dictionary(id);
      const manifest = dictionary.manifest;
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      return this.call("install", {
        dictionary: this.workerDictionary(id),
        file,
        totalBytes: file.size,
        compression: head[0] === 0x1f && head[1] === 0x8b ? "gzip" : "none",
        schemaVersion: manifest.schemaVersion,
        version: manifest.version,
        dictionaryId: manifest.id || dictionary.id,
        frequency: null
      });
    }

    remove(id = this.activeDictionaryId) {
      return this.call("remove", { dictionary: this.workerDictionary(id) });
    }

    async query(word, id = this.activeDictionaryId) {
      return this.call("query", { dictionary: this.workerDictionary(id), frequency: await this.frequencyOptions(id), word: String(word || "").trim() });
    }

    async queryMany(words, id = this.activeDictionaryId) {
      return this.call("queryMany", { dictionary: this.workerDictionary(id), frequency: await this.frequencyOptions(id), words: Array.isArray(words) ? words : [] });
    }

    match(word, limit = 10, strip = false, id = this.activeDictionaryId) {
      return this.call("match", { dictionary: this.workerDictionary(id), word: String(word || "").trim(), limit, strip });
    }

    count(id = this.activeDictionaryId) {
      return this.call("count", { dictionary: this.workerDictionary(id) });
    }

    async list(options = {}, id = this.activeDictionaryId) {
      return this.call("list", { dictionary: this.workerDictionary(id), frequency: await this.frequencyOptions(id), options });
    }

    async studyList(options = {}, id = this.activeDictionaryId) {
      return this.call("studyList", { dictionary: this.workerDictionary(id), frequency: await this.frequencyOptions(id), options });
    }

    onProgress(listener) {
      this.progressListeners.add(listener);
      return () => this.progressListeners.delete(listener);
    }
  }

  window.langLSRWDictionary = new DictionaryService();
})();
