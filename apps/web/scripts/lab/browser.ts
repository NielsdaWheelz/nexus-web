// follow the real password form's continuation. callers own authenticated
// readiness, identity checks, browser lifetime and any scenario-specific reset.
import type { Page } from "@playwright/test";
import { DEFAULT_RETURN_TARGET } from "@/lib/auth/urls";
import { WIRE_REVISION } from "@/lib/api/wire.gen";

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
