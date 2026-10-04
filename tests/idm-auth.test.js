const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const issuer = "https://idm.mltz.tech/auth/oidc/bookhill";
const raw = fs.readFileSync(path.join(__dirname, "../src/idm-auth.js"), "utf8");
const source = raw.replace(/const library = \(\) => import\([^;]+;/, "const library = () => Promise.resolve(testOAuth);");
const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

async function browser({ claims = {}, state = "state", signature = true, userinfoSub = "idm-a", age = 0 } = {}) {
  const oauth = await import("../src/vendor/oauth4webapi/index.js");
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${encode({ alg: "ES256", kid: "test" })}.${encode({ iss: issuer, aud: "bookhill", sub: "idm-a",
    exp: now + 300, iat: now, nonce: "nonce", ...claims })}`;
  const signingKey = signature ? pair.privateKey : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const jwt = signed + "." + crypto.sign("sha256", Buffer.from(signed), { key: signingKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const mockFetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: String(options.body || "") });
    let body;
    if (String(url).endsWith("openid-configuration")) body = { issuer, authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token", userinfo_endpoint: issuer + "/userinfo",
      jwks_uri: issuer + "/public_key.jwk", id_token_signing_alg_values_supported: ["ES256"] };
    else if (String(url).endsWith("/token")) body = { access_token: "access", token_type: "Bearer", expires_in: 3600, id_token: jwt };
    else if (String(url).endsWith("public_key.jwk")) body = { keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "ES256" }] };
    else if (String(url).endsWith("userinfo")) body = { sub: userinfoSub, name: "Hill" };
    else throw new Error("unexpected request");
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  const options = { [oauth.customFetch]: mockFetch };
  const testOAuth = { ...oauth,
    discoveryRequest: url => oauth.discoveryRequest(url, options),
    authorizationCodeGrantRequest: (...args) => oauth.authorizationCodeGrantRequest(...args, options),
    userInfoRequest: (...args) => oauth.userInfoRequest(...args, options),
    validateApplicationLevelSignature: (...args) => oauth.validateApplicationLevelSignature(...args, options)
  };
  const storage = new Map([["langLSRWIdmAttempt", JSON.stringify({ state: "state", nonce: "nonce", verifier: "v".repeat(43),
    createdAt: Date.now() - age, redirectUri: "https://lang.mltz.tech/" })]]);
  let visibleUrl = `https://lang.mltz.tech/?code=code&state=${state}`;
  const context = { testOAuth, URL, URLSearchParams, Date, console,
    document: { currentScript: { src: "https://lang.mltz.tech/src/idm-auth.js" }, querySelector: () => ({ content: issuer }) },
    location: { href: visibleUrl, origin: "https://lang.mltz.tech", pathname: "/", assign: url => { visibleUrl = String(url); } },
    history: { replaceState: (_a, _b, url) => { visibleUrl = String(url); } },
    sessionStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k), setItem: (k, v) => storage.set(k, v) },
    window: {} };
  vm.runInNewContext(source, context);
  const result = await context.window.langLSRWIdmAuth.ready;
  return { result, calls, storage, visibleUrl, currentUrl: () => visibleUrl, auth: context.window.langLSRWIdmAuth };
}

test("login starts at the account portal issuer with the original BookHill callback and S256", async () => {
  const b = await browser();
  await b.auth.startLogin();
  const url = new URL(b.currentUrl());
  assert.equal(url.origin + url.pathname, issuer + "/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://lang.mltz.tech/");
  assert.equal(url.searchParams.get("client_id"), "bookhill");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("OIDC uses PKCE, validates ES256, removes callback parameters and never persists tokens", async () => {
  const b = await browser();
  assert.equal(b.result.error, undefined, b.result.error?.message);
  assert.equal(b.result.user.sub, "idm-a");
  assert.equal(b.visibleUrl, "https://lang.mltz.tech/");
  assert.equal(b.storage.size, 0);
  assert.ok(b.calls.find(c => c.url.endsWith("/token")).body.includes("code_verifier="));
  b.auth.clear();
  assert.equal(b.auth.user(), null);
});

test("reject wrong state, expired attempts, issuer, audience, nonce, expiry, signature and userinfo identity", async () => {
  for (const options of [{ state: "bad" }, { age: 600001 }, { claims: { iss: "https://evil.example" } },
    { claims: { aud: "xnav" } }, { claims: { nonce: "wrong" } }, { claims: { exp: 1 } },
    { signature: false }, { userinfoSub: "idm-b" }]) {
    const b = await browser(options);
    assert.ok(b.result.error, JSON.stringify(options));
    assert.equal(b.auth.user(), null);
    assert.equal(b.storage.size, 0);
  }
});
