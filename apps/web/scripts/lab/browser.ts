// lab browsers and the real password form's continuation. callers own
// authenticated readiness, identity checks and any scenario-specific reset.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, firefox, type BrowserContext, type Page } from "@playwright/test";
import { DEFAULT_RETURN_TARGET } from "@/lib/auth/urls";
import { WIRE_REVISION } from "@/lib/api/wire.gen";

/** the canonical shell opens only over a persistent store: a real temporary profile
 * with normal durable-storage permission. chromium pins the lab's TLS leaf;
 * firefox imports the lab CA into only its temporary NSS profile and verifies TLS.
 * a non-null state seeds the fresh profile. chromium revokes its grant when its CDP session
 * detaches, so the session stays attached to the returned page until close(); callers
 * keep that page open. firefox's macOS app-data bookkeeping also belongs to the
 * temporary root. close() removes all browser state. */
export async function openLabBrowser(input: {
  web_origin: string;
  storage_state: string | null;
} & (
  | { browser?: "chromium"; web_tls: { leaf_spki_sha256: string } }
  | { browser: "firefox"; web_tls: { ca_file: string } }
)): Promise<{ context: BrowserContext; page: Page; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "nexus-lab-browser-"));
  const profile = join(directory, "profile");
  let context: BrowserContext | null = null;
  try {
    await mkdir(profile);
    if (input.browser === "firefox") {
      const run = promisify(execFile);
      await run("certutil", ["-N", "-d", `sql:${profile}`, "--empty-password"]);
      await run("certutil", ["-A", "-d", `sql:${profile}`, "-n", "nexus-lab-ca", "-t", "C,,", "-i", input.web_tls.ca_file]);
      // playwright 1.64.1's gecko bridge omits persistent-storage when applying
      // grants. seed the normal user grant using its pinned firefox schema 13.
      await run("sqlite3", [join(profile, "permissions.sqlite"), `
        PRAGMA user_version=13;
        CREATE TABLE moz_perms (id INTEGER PRIMARY KEY,origin TEXT,type TEXT,permission INTEGER,expireType INTEGER,expireTime INTEGER,modificationTime INTEGER);
        CREATE TABLE moz_hosts (id INTEGER PRIMARY KEY,host TEXT,type TEXT,permission INTEGER,expireType INTEGER,expireTime INTEGER,modificationTime INTEGER,isInBrowserElement INTEGER);
        CREATE TABLE moz_origin_interactions (origin TEXT PRIMARY KEY,lastInteractionTime INTEGER);
        INSERT INTO moz_perms(origin,type,permission,expireType,expireTime,modificationTime)
        VALUES('${input.web_origin.replaceAll("'", "''")}','persistent-storage',1,0,0,${Date.now()});
      `]);
      const appData = join(directory, "app-data");
      if (process.platform === "darwin") {
        // precreation avoids macos's deny-delete acl on automatic home folders.
        await Promise.all(["Library/Application Support", "Library/Caches", "Downloads"].map(part => mkdir(join(appData, part), { recursive: true })));
      }
      context = await firefox.launchPersistentContext(profile, {
        args: [], ignoreHTTPSErrors: false,
        ...(process.platform === "darwin" ? { env: { ...process.env, CFFIXED_USER_HOME: appData } } : {}),
      });
    } else {
      context = await chromium.launchPersistentContext(profile, {
        args: [`--ignore-certificate-errors-spki-list=${input.web_tls.leaf_spki_sha256}`],
      });
    }
    if (input.storage_state !== null) await context.setStorageState(input.storage_state);
    const page = context.pages()[0] ?? await context.newPage();
    if (input.browser === "firefox") {
      await page.goto(`${input.web_origin}/robots.txt`, { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => {
        if ((await navigator.permissions.query({ name: "persistent-storage" })).state !== "granted")
          throw new Error("firefox lab persistent-storage permission was not granted");
        const persisted = await Promise.race([
          navigator.storage.persist(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("firefox lab persistence request timed out")), 5000)),
        ]);
        if (!persisted || !await navigator.storage.persisted()) throw new Error("firefox lab storage is not persistent");
      });
    } else {
      const session = await context.newCDPSession(page);
      await session.send("Browser.grantPermissions", { origin: input.web_origin, permissions: ["durableStorage"] });
    }
    const opened = context;
    return { context: opened, page, close: async () => {
      try { await opened.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await context?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export async function login(
  page: Page,
  input: { web_origin: string; email: string; password: string },
): Promise<void> {
  const origin = new URL(input.web_origin);
  if (origin.origin !== input.web_origin || origin.hostname !== "127.0.0.1" || origin.protocol !== "https:")
    throw new Error("browser login requires an exact loopback https origin");
  await page.goto(`${input.web_origin}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Use email and password", exact: true }).click();
  const form = page.getByRole("form", { name: "Sign in with email and password", exact: true });
  await form.getByRole("textbox", { name: "Email", exact: true }).fill(input.email);
  await form.getByLabel("Password", { exact: true }).fill(input.password);
  // The hydrated form owns navigation. Its manual-redirect fetch can appear
  // aborted after a successful sign-in; callers verify the landed identity.
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${input.web_origin}${DEFAULT_RETURN_TARGET}`, { waitUntil: "domcontentloaded" });
}

/** The browser owns h2, cookies and redirects; blank setup uses a neutral document. */
export async function browserRequest(page: Page, input: {
  web_origin: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers: Readonly<Record<string, string>>;
  body: unknown | null;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const origin = new URL(input.web_origin);
  const destination = new URL(input.path, origin);
  if (origin.origin !== input.web_origin || origin.protocol !== "https:" || origin.hostname !== "127.0.0.1" ||
    !input.path.startsWith("/") || destination.origin !== origin.origin)
    throw new Error("browser requests require an exact loopback https origin and a same-origin path");
  if (page.url() === "about:blank")
    await page.goto(`${input.web_origin}/robots.txt`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).origin !== input.web_origin)
    throw new Error("browser requests require a document on the lab origin");
  return page.evaluate(async ({ input, wire }) => {
    const headers = new Headers(input.headers);
    // Fetch owns Origin; callers cannot substitute another origin for a browser request.
    headers.delete("Origin");
    if (!headers.has("X-Nexus-Wire")) headers.set("X-Nexus-Wire", String(wire));
    if (input.body !== null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(input.path, {
      method: input.method,
      headers,
      body: input.body === null ? null : JSON.stringify(input.body),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) };
  }, { input, wire: WIRE_REVISION });
}
