const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] || "";

test("index.html has a Content-Security-Policy", () => {
  assert.ok(csp, "CSP meta tag is missing");
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(inline|eval)'/, "scripts must not allow unsafe-inline / unsafe-eval");
});

test("every inline <script> is allowed by its sha256 in the CSP", () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(inline.length > 0);
  inline.forEach((body) => {
    const hash = `'sha256-${crypto.createHash("sha256").update(body).digest("base64")}'`;
    assert.ok(csp.includes(hash), `inline script changed: put ${hash} into script-src`);
  });
});

test("no inline event handlers or javascript: URLs (CSP would block them)", () => {
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  assert.doesNotMatch(html, /javascript:/i);
});
