// disposable browser bootstrap. the runtime owns the private input and verifies
// the returned identity; this helper owns real password login and a fresh state.
// stdout is exactly one json result. diagnostics belong on stderr.
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chromium } from "@playwright/test";
import { WIRE_REVISION, type components } from "@/lib/api/wire.gen";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";

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
  if (origin.origin !== input.web_origin || origin.hostname !== "127.0.0.1" || origin.protocol !== "http:")
    throw new Error("browser bootstrap requires an exact loopback http origin");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const page = await context.newPage();
    await page.goto(`${input.web_origin}/login`, { waitUntil: "domcontentloaded" });
    // chromium owns form cookies and Origin. observe the real redirect response:
    // browser fetch deliberately exposes manual redirects as opaque responses.
    const [login] = await Promise.all([
      page.waitForResponse((response) =>
        response.url() === `${input.web_origin}/auth/password/sign-in` &&
        response.request().method() === "POST",
      ),
      page.evaluate(async (seed) => {
        await fetch("/auth/password/sign-in", {
          method: "POST",
          body: new URLSearchParams({ email: seed.email, password: seed.password, next: "/" }),
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      }, input.seed),
    ]);
    if (login.status() !== 303)
      throw new Error(`browser login refused: expected 303, received ${login.status()}`);
    await page.goto(`${input.web_origin}/`, { waitUntil: "domcontentloaded" });
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
