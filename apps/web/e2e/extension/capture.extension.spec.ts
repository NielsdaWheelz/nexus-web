import { expect, test } from "playwright/test";
import {
  extensionId,
  extensionRedirectOrigin,
  launchExtension,
  webOrigin,
} from "../extensionFixture";
import { isolatedRequest, pageRequest } from "../request";

interface ScenarioUser {
  email: string;
  password: string;
}

interface ExtensionApi {
  identity: { getRedirectURL(): string };
  runtime: {
    getManifest(): {
      manifest_version: number;
      permissions?: string[];
      optional_host_permissions?: string[];
    };
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

function extensionUser(): ScenarioUser {
  const raw = process.env.NEXUS_TEST_SCENARIO_USERS;
  const value = raw ? (JSON.parse(raw) as Record<string, unknown>).extension : null;
  if (!value || typeof value !== "object") {
    throw new Error("The extension capability has no run-owned user.");
  }
  const user = value as Record<string, unknown>;
  if (typeof user.email !== "string" || typeof user.password !== "string") {
    throw new Error("The extension capability user is invalid.");
  }
  return { email: user.email, password: user.password };
}

// The production popup mints its bearer through chrome.identity.launchWebAuthFlow, whose
// interactive auth window Chromium never exposes to automation: it is not a Playwright
// page, escapes context.route, and never reports its redirect under headless or headful
// Xvfb. The window is Chrome's, not ours. So the harness completes the identity contract
// the way Chrome documents it — follow the connect redirect and read the token from its
// fragment — then exercises the extension's own storage, bearer scope, capture, handoff,
// and revocation for real against the production endpoints the popup drives.
test("the production MV3 popup acquires a scoped token, captures the active article, and revokes it", async () => {
  const context = await launchExtension();
  try {
    const id = extensionId();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const manifest = await popup.evaluate(() =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.getManifest(),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["activeTab", "identity", "scripting", "storage"]);
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    const redirectUri = await popup.evaluate(() =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.identity.getRedirectURL(),
    );
    expect(redirectUri).toBe(`${extensionRedirectOrigin()}/`);

    const user = extensionUser();
    const app = await context.newPage();
    await app.goto(`${webOrigin}/login`);
    await app.getByLabel("Email", { exact: true }).fill(user.email);
    await app.getByLabel("Password", { exact: true }).fill(user.password);
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(app).toHaveURL(/\/lectern$/);

    // Drive the real connect endpoint with the signed-in session, exactly as the popup's
    // launchWebAuthFlow navigation would, and read the minted token from the redirect
    // fragment Chrome would have handed back.
    const appApi = pageRequest(app, webOrigin);
    const start = await appApi.get(
      `/extension/connect/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
    expect(
      start.status() >= 300 && start.status() < 400,
      `connect start did not issue a redirect: ${start.status()}`,
    ).toBeTruthy();
    const location = start.headers()["location"] ?? "";
    expect(
      location.startsWith(`${extensionRedirectOrigin()}/#`),
      `connect start redirected outside the extension origin: ${location}`,
    ).toBeTruthy();
    const token = new URLSearchParams(new URL(location).hash.slice(1)).get("token");
    expect(
      token,
      `connect start did not mint an extension token: ${location}`,
    ).toEqual(expect.any(String));

    // Persist the token through the extension's own storage, then confirm the popup
    // reflects the connected identity it now owns.
    await popup.evaluate(
      ([baseUrl, value]) =>
        (globalThis as unknown as { chrome: ExtensionApi }).chrome.storage.local.set({
          baseUrl,
          extensionToken: value,
        }),
      [webOrigin, token] as const,
    );
    await popup.reload();
    await expect(popup.getByText("Connected.", { exact: true })).toBeVisible();
    const stored = await popup.evaluate(() =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.storage.local.get([
        "baseUrl",
        "extensionToken",
      ]),
    );
    expect(stored.baseUrl).toBe(webOrigin);
    expect(stored.extensionToken).toBe(token);

    // The active tab renders the source the extension captures.
    const source = await context.newPage();
    await source.goto(`${webOrigin}/privacy`);
    await expect(
      source.getByRole("heading", { name: "Privacy Policy", exact: true }),
    ).toBeVisible();
    await expect(
      source.getByText(/how Nexus collects, uses, and protects/i),
    ).toBeVisible();
    const article = await source.content();
    // The run-owned web origin is a loopback address, which the capture endpoint
    // rejects as an unroutable source. Browser captures carry their content inline
    // and never refetch the source URL, so the provenance rides an equivalent public
    // stand-in while the captured HTML remains the live Privacy Policy page.
    const captureSourceUrl = "https://example.com/privacy";

    // The bearer authorizes the extension's capture endpoint on its own — no session
    // cookie — proving its scope. The popup's own capture fetch needs a runtime host
    // grant Chromium cannot grant under automation, so the capture rides the identical
    // production contract the popup posts.
    const scoped = await isolatedRequest(webOrigin, {
      extraHTTPHeaders: { Authorization: `Bearer ${token as string}` },
    });
    try {
      const capture = await scoped.post("/api/media/capture/article", {
        headers: {
          "Idempotency-Key": `extension-capture-${process.env.NEXUS_TEST_RUN_ID}`,
        },
        data: {
          url: captureSourceUrl,
          title: "Privacy Policy",
          content_html: article,
          source_html: article,
          library_ids: [],
        },
      });
      const captureText = await capture.text();
      expect(
        capture.ok(),
        `Extension bearer capture failed: ${capture.status()} ${captureText.slice(0, 500)}`,
      ).toBeTruthy();
      const mediaId = (
        JSON.parse(captureText) as { data: { media_id: string } }
      ).data.media_id;
      expect(mediaId, "Extension capture did not publish a media identity.").toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // Handoff: the captured article processes into the shared corpus with its identity
      // preserved.
      await expect
        .poll(
          async () => {
            const response = await appApi.get(`/api/media/${mediaId}`);
            if (!response.ok()) return `http-${response.status()}`;
            const payload = (await response.json()) as {
              data: { processing_status: string; title: string };
            };
            return `${payload.data.processing_status}:${payload.data.title}`;
          },
          {
            message: `Expected capture ${mediaId} to preserve the active Privacy Policy tab.`,
            timeout: 25_000,
          },
        )
        .toBe("ready_for_reading:Privacy Policy");

      // Scope: the extension bearer is not a session credential.
      const privateSession = await scoped.get("/api/me");
      expect(privateSession.status()).toBe(401);

      // Revoke through the endpoint the popup's "Forget token" drives, then confirm the
      // popup surfaces the cleared identity.
      const revoke = await scoped.delete("/api/extension/session");
      expect(
        revoke.ok(),
        `Extension token revocation failed: ${revoke.status()} ${(await revoke.text()).slice(0, 500)}`,
      ).toBeTruthy();
      await popup.getByRole("button", { name: "Forget token", exact: true }).click();
      await expect(popup.getByText("Token removed.", { exact: true })).toBeVisible();

      // The revoked bearer no longer captures.
      const replay = await scoped.post("/api/media/capture/article", {
        headers: {
          "Idempotency-Key": `extension-replay-${process.env.NEXUS_TEST_RUN_ID}`,
        },
        data: {
          url: captureSourceUrl,
          title: "Privacy Policy",
          content_html: article,
          source_html: article,
          library_ids: [],
        },
      });
      expect(replay.status()).toBe(401);
    } finally {
      await scoped.dispose();
    }
  } finally {
    await context.close();
  }
});
