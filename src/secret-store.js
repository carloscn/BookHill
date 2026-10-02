// Protecting the AI API key at rest. WebCrypto only; loaded by the page and by
// node tests (tests/secret-store.test.js).
//
// Protection modes (chosen in 「AI 配置」):
//   device      AES-GCM with a random, NON-EXTRACTABLE key that lives in this
//               browser's IndexedDB. Storage never holds the API key in clear
//               text, and the ciphertext is useless on another device.
//   passphrase  AES-GCM with a key derived from the user's unlock password
//               (PBKDF2-SHA256, 600k iterations). Needed once per tab.
//   session     not stored at all; kept in memory until the page closes.
// Every ciphertext is bound (AES-GCM additional data) to the user and the API
// origin, so it cannot be moved to another user or replayed against another host.
//
// What this does NOT stop: script running inside this page (XSS) can use the
// key while it is unlocked. That is what the Content-Security-Policy in
// index.html is for.
(function (root, factory) {
  const api = factory(root.crypto || (typeof require === "function" ? require("node:crypto").webcrypto : undefined));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.langLSRWSecretStore = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto) {
  const subtle = webcrypto.subtle;
  const PBKDF2_ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toBase64(bytes) {
    let binary = "";
    new Uint8Array(bytes).forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function fromBase64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }

  function randomBytes(length) {
    return webcrypto.getRandomValues(new Uint8Array(length));
  }

  function additionalData(context) {
    return encoder.encode(`langLSRW-ai-key|${context.user}|${context.origin}`);
  }

  // Random AES-GCM key that script cannot export — only use.
  function generateDeviceKey() {
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function derivePassphraseKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
    const material = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encrypt(key, plaintext, context) {
    const iv = randomBytes(12);
    const data = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(context) }, key, encoder.encode(plaintext));
    return { iv: toBase64(iv), data: toBase64(data) };
  }

  async function decrypt(key, box, context) {
    try {
      const plain = await subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(box.iv), additionalData: additionalData(context) },
        key,
        fromBase64(box.data)
      );
      return decoder.decode(plain);
    } catch {
      throw new Error("无法解密 API Key（密码不对，或保存的数据已失效）。");
    }
  }

  // Box for the "passphrase" mode: salt and iteration count travel with it.
  async function sealWithPassphrase(passphrase, plaintext, context) {
    const salt = randomBytes(16);
    const key = await derivePassphraseKey(passphrase, salt);
    return { ...(await encrypt(key, plaintext, context)), salt: toBase64(salt), iterations: PBKDF2_ITERATIONS };
  }

  async function openWithPassphrase(passphrase, box, context) {
    const key = await derivePassphraseKey(passphrase, fromBase64(box.salt), box.iterations || PBKDF2_ITERATIONS);
    return decrypt(key, box, context);
  }

  // The API key may only be sent over HTTPS (plain http only to this machine).
  function checkBaseUrl(value) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch {
      return { ok: false, error: "接口地址不是有效的网址。" };
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return { ok: false, error: "接口地址必须以 https:// 开头（只有本机 localhost 可以用 http）。" };
    }
    if (url.username || url.password) return { ok: false, error: "接口地址里不能包含用户名或密码。" };
    return { ok: true, origin: url.origin, baseUrl: url.href.replace(/\/+$/, "") };
  }

  // "sk-proj-…a1b2" — enough to recognise a key, useless to anyone else.
  function keyHint(apiKey) {
    const key = String(apiKey || "").trim();
    if (key.length <= 8) return "••••";
    const prefix = key.match(/^[a-z]+-(?:[a-z]+-)?/i)?.[0] || "";
    return `${prefix}…${key.slice(-4)}`;
  }

  // ---- device key persistence (browser only) -------------------------------
  const DB_NAME = "langLSRWSecrets";
  let deviceKeyPromise = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本机密钥存储。"));
    });
  }

  function idb(mode, work) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction("keys", mode);
      const request = work(transaction.objectStore("keys"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
    }));
  }

  // One device key per browser profile, created on first use.
  function deviceKey() {
    if (!deviceKeyPromise) {
      deviceKeyPromise = (async () => {
        const existing = await idb("readonly", (store) => store.get("device"));
        if (existing) return existing;
        const key = await generateDeviceKey();
        await idb("readwrite", (store) => store.put(key, "device"));
        return key;
      })().catch((error) => {
        deviceKeyPromise = null;
        throw error;
      });
    }
    return deviceKeyPromise;
  }

  return {
    PBKDF2_ITERATIONS,
    generateDeviceKey,
    deviceKey,
    encrypt,
    decrypt,
    sealWithPassphrase,
    openWithPassphrase,
    checkBaseUrl,
    keyHint
  };
});
