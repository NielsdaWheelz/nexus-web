import { readFileSync } from "node:fs";
import path from "node:path";
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

test("the production MV3 popup connects, captures the active article, and revokes its token", async () => {
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
    await app.getByLabel("Email").fill(user.email);
    await app.getByLabel("Password").fill(user.password);
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(app).toHaveURL(/\/lectern$/);

    await popup.getByLabel("Nexus base URL").fill(webOrigin);
    await popup.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(popup.getByText("Connected.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const stored = await popup.evaluate(() =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.storage.local.get([
        "baseUrl",
        "extensionToken",
      ]),
    );
    expect(stored.baseUrl).toBe(webOrigin);
    expect(stored.extensionToken).toEqual(expect.any(String));
    const token = stored.extensionToken as string;

    const source = await context.newPage();
    await source.goto(`${webOrigin}/privacy`);
    await expect(
      source.getByRole("heading", { name: "Privacy Policy", exact: true }),
    ).toBeVisible();
    await expect(
      source.getByText(/how Nexus collects, uses, and protects/i),
    ).toBeVisible();
    await source.bringToFront();

    await popup
      .getByRole("button", { name: "Capture current tab", exact: true })
      .click();
    const saved = popup.getByText(
      new RegExp(`^Saved\\. Open ${webOrigin.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/media/`),
    );
    await expect(saved).toBeVisible({ timeout: 25_000 });
    const mediaId = /\/media\/([0-9a-f-]{36})/i.exec(
      (await saved.textContent()) ?? "",
    )?.[1];
    expect(mediaId, "Production popup capture did not publish a media identity.").toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const appApi = pageRequest(app, webOrigin);
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
          message: `Expected Readability capture ${mediaId} to preserve the active Privacy Policy tab.`,
          timeout: 25_000,
        },
      )
      .toBe("ready_for_reading:Privacy Policy");

    const scoped = await isolatedRequest(webOrigin, {
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    try {
      const privateSession = await scoped.get("/api/me");
      expect(privateSession.status()).toBe(401);

      await popup.getByRole("button", { name: "Forget token", exact: true }).click();
      await expect(popup.getByText("Token removed.", { exact: true })).toBeVisible();

      const sourceHtml = readFileSync(
        path.resolve(
          __dirname,
          "../../../../python/tests/fixtures/real_media/nasa-water-on-moon-capture.html",
        ),
        "utf8",
      );
      const replay = await scoped.post("/api/media/capture/article", {
        headers: {
          "Idempotency-Key": `extension-replay-${process.env.NEXUS_TEST_RUN_ID}`,
        },
        data: {
          url: `${webOrigin}/privacy`,
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
