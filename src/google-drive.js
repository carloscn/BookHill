// Google sign-in + the user's data in a visible "langLSRW" folder in their
// Drive:
//   langLSRW/langlsrw-userdata.json  personal data document (src/user-data.js)
//   langLSRW/libraries/*.tsv         one file per sentence library
// (An older langlsrw-data.json from the previous app version is left untouched.)
// Pure browser code: Google Identity Services (token model) for OAuth, the
// Drive v3 REST API for storage. No backend; the client ID is public config
// read from <meta name="google-client-id">. The drive.file scope only reaches
// files this app created, so libraries must be imported through the app.
(function () {
  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.file"
  ].join(" ");
  const FILE_NAME = "langlsrw-userdata.json";
  const ROOT_FOLDER = "langLSRW";
  const LIBRARY_FOLDER = "libraries";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const DRIVE = "https://www.googleapis.com/drive/v3/files";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const PROFILE_KEY = "langLSRWGoogleProfile";

  let gisPromise = null;
  let tokenClient = null;
  let pendingToken = null;
  let accessToken = "";
  let tokenExpiresAt = 0;
  let fileId = "";
  let folders = {};
  let authorizedSub = "";
  let authorizedIdmSub = "";
  let generation = 0;

  function clientId() {
    return document.querySelector('meta[name="google-client-id"]')?.content.trim() || "";
  }

  function isConfigured() {
    return Boolean(clientId());
  }

  // The Picker needs a browser API key (public, restricted to this site) and
  // the Cloud project number, which is the prefix of the OAuth client id.
  function apiKey() {
    return document.querySelector('meta[name="google-api-key"]')?.content.trim() || "";
  }

  function projectNumber() {
    return clientId().split("-")[0];
  }

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        reject(new Error("无法加载 Google 登录组件，请检查网络。"));
      };
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: (response) => {
        const pending = pendingToken;
        pendingToken = null;
        if (!pending) return;
        if (response.error) {
          pending.reject(new Error(response.error_description || response.error));
          return;
        }
        pending.resolve(response);
      },
      error_callback: (error) => {
        const pending = pendingToken;
        pendingToken = null;
        if (!pending) return;
        const messages = {
          popup_failed_to_open: "浏览器拦截了 Google 登录弹窗，请允许弹窗后重试。",
          popup_closed: "Google 登录窗口已关闭。"
        };
        pending.reject(new Error(messages[error?.type] || "Google 登录失败。"));
      }
    });
    return tokenClient;
  }

  // Must be called from a user gesture (click/keypress): GIS opens a popup.
  async function requestToken({ selectAccount = false, email = "" } = {}) {
    if (!isConfigured()) throw new Error("尚未配置 Google Client ID。");
    await loadGis();
    const client = ensureTokenClient();
    if (pendingToken) throw new Error("Google 授权正在进行，请稍候");
    return new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
      client.requestAccessToken({
        prompt: selectAccount ? "select_account" : "",
        hint: email || undefined
      });
    });
  }

  function hasToken() {
    return Boolean(accessToken && authorizedSub && authorizedIdmSub === window.langLSRWIdmAuth?.user()?.sub)
      && Date.now() < tokenExpiresAt;
  }

  function getProfile() {
    try {
      const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      return profile?.sub ? profile : null;
    } catch {
      return null;
    }
  }

  async function api(url, options = {}) {
    if (!["https://www.googleapis.com", "https://sheets.googleapis.com"].includes(new URL(url).origin)) {
      throw new Error("云盘接口地址无效，已停止操作");
    }
    if (!hasToken()) {
      const error = new Error("Google 连接已过期，请重新连接。");
      error.code = "token_expired";
      throw error;
    }
    const expected = await window.langLSRWIdmAuth.requireGoogleLink();
    if (!hasToken() || expected.sub !== authorizedSub) {
      signOut();
      throw new Error("Google 绑定已改变，请重新连接已绑定的账户");
    }
    const epoch = generation;
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
    if (epoch !== generation || !hasToken()) throw new Error("账户已变更，请重新连接云盘");
    if (response.status === 401) {
      accessToken = "";
      const error = new Error("Google 连接已过期，请重新连接。");
      error.code = "token_expired";
      throw error;
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.error?.message || "";
        if (/has not been used|is disabled|SERVICE_DISABLED/i.test(JSON.stringify(body))) {
          const service = /sheets/i.test(url) ? "Google Sheets API" : "Google Drive API";
          detail = `Google Cloud 项目还没有启用 ${service}，请先启用（见 deploy/README.md）`;
        }
      } catch {}
      const error = new Error(detail || `Google 接口错误（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async function signIn({ selectAccount = false } = {}) {
    const epoch = ++generation;
    accessToken = "";
    authorizedSub = "";
    const idmSub = window.langLSRWIdmAuth.user()?.sub;
    const expected = await window.langLSRWIdmAuth.requireGoogleLink();
    const response = await requestToken({ selectAccount, email: expected.email });
    if (typeof response.access_token !== "string" || !response.access_token
        || !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) <= 60) {
      throw new Error("Google 授权无效，请重新连接");
    }
    if (!String(response.scope || "").split(/\s+/).includes("https://www.googleapis.com/auth/drive.file")) {
      throw new Error("没有授予云盘文件权限，无法同步词库");
    }
    // Never use an unverified token for Drive/Sheets. Userinfo is the only permitted first request.
    const infoResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${response.access_token}` }, credentials: "omit"
    });
    if (!infoResponse.ok) throw new Error("无法核实 Google 账户，请重新授权");
    const info = await infoResponse.json();
    const latest = await window.langLSRWIdmAuth.requireGoogleLink();
    if (epoch !== generation || window.langLSRWIdmAuth.user()?.sub !== idmSub
        || info.sub !== expected.sub || info.sub !== latest.sub) {
      throw new Error("请选择统一账户已绑定的 Google 账户；本次未访问或同步云盘");
    }
    const previous = getProfile();
    if (previous?.sub !== info.sub) {
      fileId = "";
      folders = {};
    }
    const profile = {
      sub: info.sub,
      email: info.email || "",
      name: info.name || info.email || "Google 用户",
      picture: info.picture || ""
    };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    authorizedSub = info.sub;
    authorizedIdmSub = idmSub;
    accessToken = response.access_token;
    tokenExpiresAt = Date.now() + (Number(response.expires_in) - 60) * 1000;
    return profile;
  }

  // Forgets the session locally. Consent is not revoked, so signing in again
  // is one click; users can remove access at myaccount.google.com/permissions.
  function signOut() {
    generation += 1;
    authorizedSub = "";
    authorizedIdmSub = "";
    accessToken = "";
    tokenExpiresAt = 0;
    fileId = "";
    folders = {};
    localStorage.removeItem(PROFILE_KEY);
  }

  function quote(value) {
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }

  async function findChildren(parentId, extraQuery = "", fields = "files(id,name,modifiedTime,appProperties)") {
    const files = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        q: `${quote(parentId)} in parents and trashed=false${extraQuery ? ` and ${extraQuery}` : ""}`,
        fields: `nextPageToken,${fields}`,
        orderBy: "modifiedTime desc",
        pageSize: "1000",
        spaces: "drive"
      });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await (await api(`${DRIVE}?${query}`)).json();
      files.push(...(page.files || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  // Folder ids are cached per session; the promise is cached so concurrent
  // callers never create the folder twice.
  function folder(name, parentId) {
    const key = `${parentId}/${name}`;
    if (!folders[key]) {
      folders[key] = (async () => {
        const [existing] = await findChildren(parentId, `name=${quote(name)} and mimeType=${quote(FOLDER_MIME)}`, "files(id)");
        if (existing) return existing.id;
        const created = await (await api(`${DRIVE}?fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
        })).json();
        return created.id;
      })().catch((error) => {
        delete folders[key];
        throw error;
      });
    }
    return folders[key];
  }

  const rootFolder = () => folder(ROOT_FOLDER, "root");
  const libraryFolder = async () => folder(LIBRARY_FOLDER, await rootFolder());

  function multipart(metadata, body, contentType) {
    const boundary = `langlsrw-${Math.random().toString(36).slice(2)}`;
    return {
      contentType: `multipart/related; boundary=${boundary}`,
      body: [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${contentType}`,
        "",
        body,
        `--${boundary}--`
      ].join("\r\n")
    };
  }

  // Drive only takes multipart uploads up to 5 MB; bigger bodies (a 100k-line
  // library is ~9 MB) go through a resumable session: metadata first, then the
  // content in one PUT to the session URL.
  const MULTIPART_LIMIT = 4 * 1024 * 1024;

  async function resumableUpload(id, metadata, body, contentType) {
    const blob = new Blob([body], { type: contentType });
    const session = await api(id ? `${UPLOAD}/${id}?uploadType=resumable` : `${UPLOAD}?uploadType=resumable`, {
      method: id ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentType,
        "X-Upload-Content-Length": String(blob.size)
      },
      body: JSON.stringify(metadata)
    });
    const location = session.headers.get("Location");
    if (!location) throw new Error("Google Drive 没有返回上传地址。");
    const saved = await (await api(location, { method: "PUT", headers: { "Content-Type": contentType }, body: blob })).json();
    return saved.id;
  }

  // Create (no id) or overwrite (id) a file's metadata + content.
  async function upload(id, metadata, body, contentType) {
    if (new Blob([body]).size > MULTIPART_LIMIT) return resumableUpload(id, metadata, body, contentType);
    const request = multipart(metadata, body, contentType);
    const url = id
      ? `${UPLOAD}/${id}?uploadType=multipart&fields=id`
      : `${UPLOAD}?uploadType=multipart&fields=id`;
    const saved = await (await api(url, {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": request.contentType },
      body: request.body
    })).json();
    return saved.id;
  }

  async function findFileId() {
    if (fileId) return fileId;
    const [file] = await findChildren(await rootFolder(), `name=${quote(FILE_NAME)}`, "files(id)");
    fileId = file?.id || "";
    return fileId;
  }

  async function pull() {
    const id = await findFileId();
    if (!id) return null;
    const response = await api(`${DRIVE}/${id}?alt=media`, { cache: "no-store" });
    try {
      const document = await response.json();
      if (!window.langLSRWUserData.isDocument(document)) throw new Error("invalid document");
      return document;
    } catch {
      throw new Error("云盘学习数据无法读取；已停止同步，请先备份原文件");
    }
  }

  async function push(data) {
    const id = await findFileId();
    const metadata = id
      ? { mimeType: "application/json" }
      : { name: FILE_NAME, parents: [await rootFolder()], mimeType: "application/json" };
    fileId = await upload(id, metadata, JSON.stringify(data), "application/json");
  }

  async function listLibraries() {
    const files = await findChildren(await libraryFolder());
    return files.map((file) => ({
      fileId: file.id,
      libraryId: file.appProperties?.lsrwLibraryId || "",
      name: String(file.name || "").replace(/\.tsv$/i, ""),
      language: file.appProperties?.lsrwLanguage || "",
      sheet: window.langLSRWLibraryImport?.decodeSheetLink(file.appProperties?.lsrwSheet) || null,
      updatedAt: file.appProperties?.lsrwUpdatedAt || file.modifiedTime || ""
    }));
  }

  async function downloadLibrary(id) {
    return (await api(`${DRIVE}/${id}?alt=media`, { cache: "no-store" })).text();
  }

  // Returns the Drive file id. The library id and change time ride along as
  // appProperties so a re-download needs no extra index file.
  async function uploadLibrary(id, library, tsv) {
    const metadata = {
      name: `${library.name}.tsv`,
      mimeType: "text/tab-separated-values",
      appProperties: {
        lsrwLibraryId: library.id,
        lsrwUpdatedAt: library.updatedAt,
        lsrwLanguage: library.language || "en",
        lsrwSheet: window.langLSRWLibraryImport?.encodeSheetLink(library.sheet) || null,
        lsrwSource: String(library.source || "").slice(0, 100)
      }
    };
    if (!id) metadata.parents = [await libraryFolder()];
    return upload(id, metadata, tsv, "text/tab-separated-values; charset=UTF-8");
  }

  async function trashFile(id) {
    await api(`${DRIVE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }

  // ---- Google Sheets via the Picker ------------------------------------
  // Picking a spreadsheet in Google's own Picker grants this app (drive.file)
  // read access to that one file; the Sheets API then reads its cells.
  let pickerPromise = null;

  function loadPicker() {
    if (window.google?.picker) return Promise.resolve();
    if (pickerPromise) return pickerPromise;
    pickerPromise = new Promise((resolve, reject) => {
      const done = () => window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("无法加载 Google 文件选择器。")) });
      if (window.gapi?.load) {
        done();
        return;
      }
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.async = true;
      script.onload = done;
      script.onerror = () => {
        pickerPromise = null;
        reject(new Error("无法加载 Google 文件选择器，请检查网络。"));
      };
      document.head.appendChild(script);
    });
    return pickerPromise;
  }

  // Must start from a click (it may need a token popup). Resolves to
  // { id, name } or null when the user cancels.
  async function pickSpreadsheet(fileId = "") {
    if (!apiKey()) throw new Error("还没有配置 Google API 密钥（index.html 里的 google-api-key），见 deploy/README.md。");
    if (!hasToken()) await signIn();
    const expected = await window.langLSRWIdmAuth.requireGoogleLink();
    if (!hasToken() || expected.sub !== authorizedSub) throw new Error("请重新连接已绑定的 Google 账户");
    await loadPicker();
    const { picker } = window.google;
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS).setMode(picker.DocsViewMode.LIST);
    if (fileId && typeof view.setFileIds === "function") view.setFileIds(fileId);
    return new Promise((resolve) => {
      new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey())
        .setAppId(projectNumber())
        .setTitle(fileId ? "确认要导入的表格" : "选择要导入的 Google 表格")
        .setLocale("zh-CN")
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED) {
            const doc = data.docs?.[0];
            resolve(doc ? { id: doc.id, name: doc.name || "" } : null);
          } else if (data.action === picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build()
        .setVisible(true);
    });
  }

  // Read one tab (by gid; first tab when empty) as rows of strings.
  async function readSheet(id, gid = "") {
    const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
    const meta = await (await api(`${SHEETS}/${id}?fields=properties.title,sheets.properties(sheetId,title)`)).json();
    const tabs = meta.sheets || [];
    const tab = tabs.find((sheet) => String(sheet.properties.sheetId) === String(gid)) || tabs[0];
    if (!tab) throw new Error("这个表格里没有工作表。");
    const range = encodeURIComponent(`'${tab.properties.title.replace(/'/g, "''")}'`);
    const values = await (await api(`${SHEETS}/${id}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)).json();
    return {
      title: meta.properties?.title || "",
      tabTitle: tab.properties.title,
      gid: String(tab.properties.sheetId),
      rows: values.values || []
    };
  }

  window.langLSRWGoogleDrive = {
    pickSpreadsheet,
    readSheet,
    isConfigured,
    getProfile,
    hasToken,
    signIn,
    reconnect: () => signIn(),
    signOut,
    pull,
    push,
    listLibraries,
    downloadLibrary,
    uploadLibrary,
    trashFile
  };
})();
