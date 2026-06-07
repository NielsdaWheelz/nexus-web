// CI bundle-budget gate for authenticated First Load JS.
//
// Slice S0 / AC-5 / R5 of
// docs/cutovers/first-paint-speed-streaming-and-restore-hard-cutover.md installs
// this guard. The measured authenticated First Load JS baseline is ~104 kB gz
// (the doc's §0 measurement pass); the budget below holds the line with headroom
// so a regression in shared chunks fails the PR instead of silently shipping.
//
// Source of truth: `.next/app-build-manifest.json` lists, per App Router route,
// the exact set of static JS chunks that constitute its First Load JS (shared
// root chunks + the route's own page chunk). We gzip each chunk and sum — the
// same dimension Next prints in its build route table ("First Load JS", a
// gzipped transfer size). Summing gzipped chunk sizes (not raw bytes from
// build-manifest.json) is what makes this comparable to the budget. This is
// machine-readable and deterministic; we do not parse human-formatted stdout.
//
// Fail-closed: if the manifest, an authenticated route, or a chunk file is
// missing, the script exits non-zero rather than passing silently — a build
// that produced no measurable authenticated route is itself a failure.

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Budget for authenticated First Load JS, gzipped. ~104 kB gz measured baseline
// + headroom (see spec §0 "Measured baseline → targets" and AC-5).
const BUDGET_KB = 115;

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = join(webDir, ".next");
const manifestPath = join(nextDir, "app-build-manifest.json");

function fail(message) {
  console.error(`check-bundle: ${message}`);
  process.exit(1);
}

// The manifest's `pages` keys are internal App Router route paths; authenticated
// routes live under the `(authenticated)` route group as `.../page`.
function isAuthenticatedRoute(routeKey) {
  return routeKey.startsWith("/(authenticated)/") && routeKey.endsWith("/page");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  // justify-defect: a missing/unparseable build manifest means there is no
  // production build to measure; the gate cannot pass without one.
  fail(`could not read ${manifestPath} — run a production build first (${error.message}).`);
}

const pages = manifest.pages ?? {};
const routes = Object.keys(pages).filter(isAuthenticatedRoute);
if (routes.length === 0) {
  fail("found no (authenticated) routes in app-build-manifest.json (build incomplete or layout changed).");
}

// First Load JS is the gzipped sum of a route's chunks. Authenticated routes all
// share the same chrome, so we gate on the heaviest one (the true ceiling).
function firstLoadKb(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    const chunkPath = join(nextDir, chunk);
    let raw;
    try {
      raw = readFileSync(chunkPath);
    } catch (error) {
      fail(`chunk listed in manifest is missing: ${chunk} (${error.message}).`);
    }
    total += gzipSync(raw).length;
  }
  return total / 1024;
}

let worstRoute = "";
let worstKb = 0;
for (const route of routes) {
  const kb = firstLoadKb(pages[route]);
  if (kb > worstKb) {
    worstKb = kb;
    worstRoute = route;
  }
}

const actual = worstKb.toFixed(1);
if (worstKb > BUDGET_KB) {
  fail(
    `authenticated First Load JS ${actual} kB gz EXCEEDS budget ${BUDGET_KB} kB gz ` +
      `(worst route: ${worstRoute}).`,
  );
}

console.log(
  `check-bundle: authenticated First Load JS ${actual} kB gz <= budget ${BUDGET_KB} kB gz ` +
    `(worst route: ${worstRoute}, ${routes.length} routes checked).`,
);
