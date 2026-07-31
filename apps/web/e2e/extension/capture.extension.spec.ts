import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test } from "playwright/test";
import { extensionId, launchExtension, webOrigin } from "../extensionFixture";

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
    local: { set(value: Record<string, string>): Promise<void> };
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

test("the MV3 extension completes handoff, scoped capture, and revocation", async () => {
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
    expect(redirectUri).toBe(`https://${id}.chromiumapp.org/`);

    const user = extensionUser();
    const app = await context.newPage();
    await app.goto(`${webOrigin}/login`);
    await app.getByLabel("Email").fill(user.email);
    await app.getByLabel("Password").fill(user.password);
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(app).toHaveURL(/\/lectern$/);

    const handoff = await context.request.get(
      `${webOrigin}/extension/connect/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
      { maxRedirects: 0 },
    );
    expect(handoff.status()).toBe(307);
    const location = handoff.headers().location;
    expect(location, "The extension handoff returned no redirect location.").toBeTruthy();
    const result = new URL(location!);
    expect(result.origin).toBe(new URL(redirectUri).origin);
    const token = new URLSearchParams(result.hash.slice(1)).get("token");
    expect(token, "The authenticated handoff returned no scoped bearer token.").toBeTruthy();

    await popup.evaluate(
      ({ baseUrl, extensionToken }) =>
        (globalThis as unknown as { chrome: ExtensionApi }).chrome.storage.local.set({
          baseUrl,
          extensionToken,
        }),
      { baseUrl: webOrigin, extensionToken: token! },
    );
    await popup.reload();
    await expect(popup.getByText("Connected.")).toBeVisible();

    const sourceHtml = readFileSync(
      path.resolve(__dirname, "../../../../python/tests/fixtures/real_media/nasa-water-on-moon-capture.html"),
      "utf8",
    );
    const capture = await context.request.post(`${webOrigin}/api/media/capture/article`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `extension-${process.env.NEXUS_TEST_RUN_ID}`,
      },
      data: {
        url: "https://science.nasa.gov/moon/water-on-the-moon/",
        title: "Water on the Moon",
        content_html: sourceHtml,
        source_html: sourceHtml,
        library_ids: [],
      },
    });
    expect(capture.status()).toBe(202);
    const captured = (await capture.json()) as { data?: { media_id?: unknown } };
    expect(captured.data?.media_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const scoped = await request.newContext({
      baseURL: webOrigin,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    try {
      const privateSession = await scoped.get("/api/me");
      expect(privateSession.status()).toBe(401);
      const revoked = await scoped.delete("/api/extension/session");
      expect(revoked.status()).toBe(204);
      const replay = await scoped.post("/api/media/capture/article", {
        headers: { "Idempotency-Key": `extension-replay-${process.env.NEXUS_TEST_RUN_ID}` },
        data: {
          url: "https://science.nasa.gov/moon/water-on-the-moon/",
          content_html: sourceHtml,
          source_html: sourceHtml,
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
