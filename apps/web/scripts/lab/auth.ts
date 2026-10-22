// disposable browser bootstrap. the runtime owns the private input and verifies
// the returned identity; this helper owns real password login and a fresh state.
// stdout is exactly one json result. diagnostics belong on stderr.
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { chromium } from "@playwright/test";
import { WIRE_REVISION, type components } from "@/lib/api/wire.gen";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { login } from "./browser";

interface BootstrapInput {
  web_origin: string;
  wire_revision: number;
  seed: { user_id: string; email: string; password: string };
  browser_state_file: string;
  artifacts_dir: string;
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
  if (!isAbsolute(input.artifacts_dir))
    throw new Error("browser bootstrap artifacts path must be absolute");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const page = await context.newPage();
    const redact = (value: string) => value.replaceAll(input.seed.email, "[redacted]").replaceAll(input.seed.password, "[redacted]");
    page.on("console", message => {
      if (message.type() === "error") console.error(`browser console: ${redact(message.text())}`);
    });
    page.on("pageerror", error => console.error(`browser page error: ${redact(error.message)}`));
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === input.web_origin && url.pathname.startsWith("/api/") && response.status() >= 400)
        console.error(`browser api response: ${response.status()} ${url.pathname}`);
    });
    await login(page, { web_origin: input.web_origin, ...input.seed });
    try {
      await page.getByRole("navigation", { name: "Primary", exact: true }).waitFor({ state: "visible" });
    } catch {
      await page.screenshot({ path: join(input.artifacts_dir, "browser-bootstrap-failure.png"), mask: [page.locator("input")] });
      console.error(`browser ended at: ${new URL(page.url()).pathname}`);
      throw new Error("browser authenticated primary navigation missing");
    }
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
  console.error(error instanceof Error ? error.message.split("\n")[0] : "browser bootstrap failed");
  process.exitCode = 1;
});
