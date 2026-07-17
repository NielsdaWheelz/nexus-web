import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from "@playwright/test";
import {
  activeWorkspacePane,
  gotoWithWorkspaceSession,
  singlePaneWorkspaceState,
  workspaceE2eDeviceId,
} from "./workspace";

// docs/cutovers/reader-profile-persistence-hard-cutover.md §11/§12 AC-1: this proof runs
// against the dedicated E2E-project, test-tier-owned network fault injector in front of the
// real FastAPI (e2e/reader-profile-upstream-proxy.ts) — never an internal module/router mock
// or browser route interception (page.route cannot see Next's server-side fetches anyway).
const READER_PROXY_PORT = process.env.READER_PROXY_PORT ?? "8010";
const READER_PROXY_BASE_URL = `http://localhost:${READER_PROXY_PORT}`;

// The apostrophe in the rendered heading is a curly U+2019; matching with a wildcard avoids
// any encoding footgun while still uniquely identifying the bootstrap fallback region.
const WORKSPACE_FALLBACK_HEADING = /The workspace couldn.t load/;

interface ReaderProfileProxyObservations {
  profileGets: number;
}

async function armReaderProfileFailNextGet(proxy: APIRequestContext): Promise<void> {
  const response = await proxy.post("/__e2e/reader-profile/fail-next-get");
  expect(response.ok(), `arm failed: status=${response.status()}`).toBeTruthy();
}

async function resetReaderProfileProxy(proxy: APIRequestContext): Promise<void> {
  const response = await proxy.post("/__e2e/reader-profile/reset");
  expect(response.ok(), `reset failed: status=${response.status()}`).toBeTruthy();
}

async function readReaderProfileGetCount(proxy: APIRequestContext): Promise<number> {
  const response = await proxy.get("/__e2e/reader-profile/observations");
  expect(response.ok(), `observations read failed: status=${response.status()}`).toBeTruthy();
  const body = (await response.json()) as ReaderProfileProxyObservations;
  return body.profileGets;
}

test.describe("reader profile bootstrap recovery", () => {
  let proxy: APIRequestContext;

  test.beforeEach(async () => {
    proxy = await apiRequest.newContext({ baseURL: READER_PROXY_BASE_URL });
    await resetReaderProfileProxy(proxy);
  });

  test.afterEach(async () => {
    // A failed assertion mid-test must not leave the proxy armed/counted for whatever spec
    // runs next in this worker: `workers: 1`, so every project shares the one running proxy.
    await resetReaderProfileProxy(proxy).catch(() => {});
    await proxy.dispose();
  });

  // AC-1 / §11 delivery plan / §12 "real-stack E2E": the fault injector fails exactly the
  // first server-to-server GET /me/reader-profile, the required bootstrap read rejects into
  // the scoped AuthenticatedWorkspaceErrorBoundary fallback (never a fabricated Light
  // default), and Retry's fresh Server Component request (router.refresh()) succeeds against
  // the now-unarmed upstream. A boundary re-render alone must not pass — the proof is that a
  // second, real, counted GET occurred.
  test("@recovery armed profile GET failure shows the workspace fallback; Retry reveals the shell after a second GET", async ({
    page,
  }, testInfo) => {
    await armReaderProfileFailNextGet(proxy);

    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-reader-profile-recovery");
    await gotoWithWorkspaceSession(
      page,
      deviceId,
      singlePaneWorkspaceState("/libraries"),
      "/libraries",
    );

    const fallback = page.getByRole("alert", { name: WORKSPACE_FALLBACK_HEADING });
    await expect(fallback).toBeVisible({ timeout: 15_000 });
    await expect(fallback).toBeFocused();

    // The shell never rendered — the boundary replaced the whole Suspense/gate subtree.
    await expect(activeWorkspacePane(page)).toHaveCount(0);
    await expect(page.getByTestId("shell-skeleton")).toHaveCount(0);

    await expect.poll(() => readReaderProfileGetCount(proxy)).toBe(1);

    await fallback.getByRole("button", { name: "Retry" }).click();

    await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
    await expect(fallback).toHaveCount(0);

    await expect.poll(() => readReaderProfileGetCount(proxy)).toBe(2);
  });
});
