/**
 * Build/run mode (NODE_ENV). CLIENT-SAFE: Next statically inlines `process.env.NODE_ENV`, so
 * these are importable from Client Components. No secrets, no NEXUS_ENV.
 *
 * This is the build axis, not the deployment axis: `next start` forces NODE_ENV=production for
 * every E2E and local production run, regardless of where the code is deployed. "Am I deployed
 * to staging/prod?" lives in ./env (NEXUS_ENV) — never confuse the two.
 */
export function isDevBuild(): boolean {
  return process.env.NODE_ENV === "development";
}

export function isProdBuild(): boolean {
  return process.env.NODE_ENV === "production";
}
