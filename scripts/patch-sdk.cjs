// Postinstall patch: make @codebuff/sdk loadable inside Paseo's plugin bundle.
//
// Paseo bundles server code with esbuild (platform=node, format=cjs) and
// evaluates it via eval(), where `import.meta.url` / `__filename` do not
// exist. Two SDK internals break under that:
//
// 1. @vercel/oidc (via @ai-sdk/gateway): its CommonJS lazy-getter interop
//    (`get: () => from[key]`) is rewritten by Paseo's makeHermesInteropEager
//    transform into an eager read of an uninitialized module, failing load
//    with "Cannot read properties of undefined (reading 'getContext')".
//    The freebuff provider never uses the Vercel OIDC path, so the entry is
//    replaced with a stub that throws only when actually called.
// 2. `createRequire(import.meta.url)` in dist/index.mjs: `import.meta.url`
//    is undefined in the eval context, failing load with
//    "The argument 'filename' ... Received undefined". The resulting
//    `__require` is only used for Node builtins (fs/path/child_process),
//    which Paseo's runtimeRequire resolves, so it is redirected to the
//    bundle-scoped `require`.
//
// Run via the package.json postinstall hook and the paseo-plugin.json build
// field (for Git/npm installs). Re-check after every @codebuff/sdk upgrade.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let patched = 0;

function patchFile(rel, replacements) {
  const p = path.join(ROOT, rel);
  let s;
  try {
    s = fs.readFileSync(p, "utf8");
  } catch {
    console.log(`patch-sdk: missing ${rel}, skip`);
    return;
  }
  let changed = false;
  for (const [from, to] of replacements) {
    if (s.includes(from)) {
      s = s.split(from).join(to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(p, s);
    patched += 1;
    console.log(`patch-sdk: patched ${rel}`);
  } else {
    console.log(`patch-sdk: ${rel} already patched or pattern missing`);
  }
}

const OIDC_STUB =
  "module.exports={getContext:()=>({})," +
  "getVercelOidcToken:async()=>{throw new Error('@vercel/oidc stub: unavailable')}," +
  "getVercelOidcTokenSync:()=>{throw new Error('@vercel/oidc stub: unavailable')}};";

// Overwrite the whole oidc entry files with the stub.
for (const rel of [
  "node_modules/@vercel/oidc/dist/index.js",
  "node_modules/@ai-sdk/gateway/node_modules/@vercel/oidc/dist/index.js",
]) {
  const p = path.join(ROOT, rel);
  try {
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, OIDC_STUB);
      console.log(`patch-sdk: stubbed ${rel}`);
    }
  } catch (error) {
    console.log(`patch-sdk: skip ${rel}: ${error.message}`);
  }
}

// Redirect the ESM build's createRequire to the bundle require.
patchFile("node_modules/@codebuff/sdk/dist/index.mjs", [
  ["var __require = /* @__PURE__ */ createRequire(import.meta.url);", "var __require = require;"],
]);

console.log(`patch-sdk: done (${patched} pattern file(s))`);
