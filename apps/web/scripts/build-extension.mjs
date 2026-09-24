// Builds the Firefox capture extension into apps/extension/dist.
//
// The output tree is a build artifact, not source: it is git-ignored and
// `./scripts/test` builds it before the CSS-token closure check. The source
// manifest and icons in apps/extension have one owner; this script copies them,
// pins the build's nexus/storage origins into the bundles and the manifest's
// optional_permissions, and fails on any manifest reference the build did not
// produce.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(webDir, "../extension");
const outputDir = join(extensionDir, "dist");

// A bare http(s) origin, exactly as the URL parser serializes it: no path,
// query, fragment, credentials or trailing slash.
function pinnedOrigin(name, localDefault) {
  const value = process.env[name] ?? localDefault;
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (url === null || !["http:", "https:"].includes(url.protocol) || url.origin !== value) {
    throw new Error(`${name} must be a bare http(s) origin such as https://nexus.example; got ${JSON.stringify(value)}`);
  }
  return url;
}

const nexus = pinnedOrigin("NEXUS_EXTENSION_NEXUS_ORIGIN", "http://localhost:3000");
const storage = pinnedOrigin("NEXUS_EXTENSION_STORAGE_ORIGIN", "http://127.0.0.1:9000");

rmSync(outputDir, { recursive: true, force: true });
for (const mode of ["popup", "background", "content"]) {
  await build({
    configFile: join(webDir, "vite.extension.config.ts"),
    mode,
    define: {
      __NEXUS_ORIGIN__: JSON.stringify(nexus.origin),
      __NEXUS_STORAGE_ORIGIN__: JSON.stringify(storage.origin),
    },
  });
}
cpSync(join(extensionDir, "icons"), join(outputDir, "icons"), { recursive: true });

const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
  throw new Error(`manifest version must be MAJOR.MINOR.PATCH; got ${JSON.stringify(manifest.version)}`);
}
// Match patterns carry no port: Firefox matches every port of the host.
manifest.optional_permissions = [
  ...new Set([
    ...(manifest.optional_permissions ?? []),
    `${nexus.protocol}//${nexus.hostname}/*`,
    `${storage.protocol}//${storage.hostname}/*`,
  ]),
];
const references = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.browser_action?.default_icon ?? {}),
  manifest.browser_action?.default_popup,
  ...(manifest.background?.scripts ?? []),
  // injected by scripting.executeScript rather than declared
  "content.js",
];
for (const reference of references) {
  if (typeof reference !== "string" || !existsSync(join(outputDir, reference))) {
    throw new Error(`manifest references a file the build did not produce: ${JSON.stringify(reference)}`);
  }
}
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
