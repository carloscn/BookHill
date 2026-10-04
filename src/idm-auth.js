// Account portal OIDC issuer: code + S256 PKCE; subject stays the Kanidm UUID.
// Credentials and tokens never enter persistent storage.
(function () {
  const scriptUrl = document.currentScript.src;
  const issuer = new URL(document.querySelector('meta[name="idm-issuer"]').content);
  const client = { client_id: "bookhill", id_token_signed_response_alg: "ES256" };
  const redirectUri = location.origin + location.pathname;
  const attemptKey = "langLSRWIdmAttempt";
  const library = () => import(new URL("vendor/oauth4webapi/index.js?v=3.8.8", scriptUrl));
  let session = null;
  let metadata = null;
  let binding = null;
  const callbacks = new URL(location.href);
  const callbackParameters = new URLSearchParams(callbacks.search);
  const isCallback = callbacks.searchParams.has("code") || callbacks.searchParams.has("error");
  if (isCallback) {
    ["code", "state", "error", "error_description", "iss", "session_state"].forEach(k => callbacks.searchParams.delete(k));
    history.replaceState(null, "", callbacks);
  }

  async function server(oauth) {
    if (!metadata) metadata = await oauth.processDiscoveryResponse(issuer,
      await oauth.discoveryRequest(issuer));
    if (metadata.issuer !== issuer.href.replace(/\/$/, "")) throw new Error("账户中心地址不匹配");
    for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"]) {
      if (new URL(metadata[key]).origin !== issuer.origin) throw new Error("账户中心接口地址不匹配");
    }
    return metadata;
  }

  async function finish(parameters) {
    if (!isCallback) return null;
    const raw = sessionStorage.getItem(attemptKey);
    sessionStorage.removeItem(attemptKey);
    const attempt = JSON.parse(raw || "null");
    if (!attempt || !Number.isFinite(attempt.createdAt) || !attempt.state || !attempt.nonce || !attempt.verifier
        || Date.now() - attempt.createdAt > 600000 || attempt.redirectUri !== redirectUri) {
      throw new Error("登录请求已失效，请重新登录");
    }
    const oauth = await library();
    const as = await server(oauth);
    const validated = oauth.validateAuthResponse(as, client, parameters, attempt.state);
    const response = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), validated,
      redirectUri, attempt.verifier);
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response,
      { expectedNonce: attempt.nonce, requireIdToken: true });
    await oauth.validateApplicationLevelSignature(as, response);
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    const profile = await oauth.processUserInfoResponse(as, client, claims.sub,
      await oauth.userInfoRequest(as, client, tokens.access_token));
    if (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("登录令牌有效期无效");
    session = { sub: claims.sub, email: profile.email || "", name: profile.name || profile.preferred_username || "统一账户",
      token: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 };
    return user();
  }

  function user() {
    if (!session || Date.now() >= session.expiresAt) return null;
    const { sub, email, name } = session;
    return { sub, email, name };
  }

  async function startLogin() {
    const oauth = await library();
    const as = await server(oauth);
    const attempt = { state: oauth.generateRandomState(), nonce: oauth.generateRandomNonce(),
      verifier: oauth.generateRandomCodeVerifier(), createdAt: Date.now(), redirectUri };
    const url = new URL(as.authorization_endpoint);
    const params = { response_type: "code", client_id: client.client_id, scope: "openid email profile",
      redirect_uri: redirectUri, state: attempt.state, nonce: attempt.nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(attempt.verifier), code_challenge_method: "S256" };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
    location.assign(url);
  }

  async function googleLink() {
    const current = user();
    if (!current) { binding = null; throw new Error("统一账户登录已过期，请重新登录"); }
    binding = null;
    const response = await fetch(new URL("/api/integrations/bookhill/google-link", issuer.origin),
      { headers: { Authorization: `Bearer ${session.token}` }, credentials: "omit", cache: "no-store" });
    if (!response.ok) { binding = null; throw new Error(response.status === 401 ? "统一账户登录已过期，请重新登录" : "暂时无法核实 Google 绑定，请重试"); }
    const data = await response.json();
    if (!user() || data.sub !== current.sub || user().sub !== current.sub) throw new Error("账户已变更，请重新登录");
    binding = data;
    return binding;
  }

  async function requireGoogleLink() {
    const data = await googleLink();
    if (!window.langLSRWIdmPolicy.linkedSubject(data, user()?.sub)) throw new Error("请先到账户中心绑定 Google，才能同步词库");
    return data.google;
  }

  function clear() { session = null; binding = null; sessionStorage.removeItem(attemptKey); }
  window.langLSRWIdmAuth = { user, startLogin, googleLink, requireGoogleLink, clear,
    get binding() { return binding; }, logout() { clear(); location.assign(new URL("/logout", issuer.origin)); } };
  window.langLSRWIdmAuth.ready = finish(callbackParameters)
    .then(user => ({ user })).catch(error => ({ error }));
})();
