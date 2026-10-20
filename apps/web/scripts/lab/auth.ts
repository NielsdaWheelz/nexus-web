// disposable browser bootstrap. the runtime owns the private input and verifies
// the returned identity; this helper owns real password login and a fresh state.
// stdout is exactly one json result. diagnostics belong on stderr.
// cold authenticated route compilation gets a bounded navigation budget; form,
// identity and visible-control checks retain their ordinary thirty-second limit.
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chromium } from "@playwright/test";
import { WIRE_REVISION, type components } from "@/lib/api/wire.gen";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

interface BootstrapInput {
  web_origin: string;
  wire_revision: number;
  seed: { user_id: string; email: string; password: string };
  browser_state_file: string;
}

async function bootstrap() {
  const inputPath = process.argv[2];
  if (process.argv.length !== 3 || !isAbsolute(inputPath))
    throw new Error("browser bootstrap requires one absolute private input path");
  // justify-type-assertion: the runtime writes this private same-system contract; its
  // generated wire revision is checked before making any application request.
  const input = JSON.parse(await readFile(inputPath, "utf8")) as BootstrapInput;
  if (input.wire_revision !== WIRE_REVISION)
    throw new Error("browser bootstrap wire revision mismatch");
  if (!isAbsolute(input.browser_state_file))
    throw new Error("browser bootstrap state path must be absolute");
  const origin = new URL(input.web_origin);
  if (origin.origin !== input.web_origin || origin.hostname !== "localhost" || origin.protocol !== "http:")
    throw new Error("browser bootstrap requires an exact localhost http origin");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(90_000);
    const page = await context.newPage();
    await page.goto(`${input.web_origin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Use email and password", exact: true }).click();
    const form = page.getByRole("form", { name: "Sign in with email and password", exact: true });
    await form.getByLabel("Email", { exact: true }).fill(input.seed.email);
    await form.getByLabel("Password", { exact: true }).fill(input.seed.password);
    // The public form owns its successful navigation. Observe the actual 303,
    // then its canonical destination; a second helper-owned goto would compete
    // with that browser flow. Identity and visible-shell checks still prove it.
    const [login] = await Promise.all([
      page.waitForResponse((response) =>
        response.url() === `${input.web_origin}/auth/password/sign-in` &&
        response.request().method() === "POST",
      ),
      form.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    if (login.status() !== 303)
      throw new Error(`browser login refused: expected 303, received ${login.status()}`);
    await page.waitForURL(new URL(APP_AUTHENTICATED_HOME_HREF, input.web_origin).href, { waitUntil: "domcontentloaded" });
    const response: { status: number; data: components["schemas"]["UserProfileOut"] | null } =
      await page.evaluate(async (wire) => {
        const response = await fetch("/api/me", {
          headers: { "X-Nexus-Wire": String(wire) },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        return {
          status: response.status,
          data: response.status === 200 ? (await response.json()).data : null,
        };
      }, WIRE_REVISION);
    if (response.status !== 200)
      throw new Error(`browser identity request failed: expected 200, received ${response.status}`);
    const { data } = response;
    if (data === null || data.user_id !== input.seed.user_id || !data.default_library_id)
      throw new Error("browser identity mismatch: expected seeded reader and default library");
    if (!(await context.cookies(input.web_origin)).some((cookie) => cookie.name === DEVICE_COOKIE_NAME && cookie.value))
      throw new Error("browser workspace device missing after authenticated navigation");
    try {
      await page.getByRole("navigation", { name: "Primary", exact: true }).waitFor({ state: "visible" });
    } catch {
      throw new Error("browser authenticated primary navigation missing");
    }
    await writeFile(input.browser_state_file, JSON.stringify(await context.storageState()), {
      mode: 0o600,
      flag: "wx",
    });
    process.stdout.write(JSON.stringify({ user_id: data.user_id, default_library_id: data.default_library_id }) + "\n");
  } finally {
    await browser.close();
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "browser bootstrap failed");
  process.exitCode = 1;
});
