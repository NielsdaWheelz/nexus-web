/** Public immutable shell template, never private HTML. Account admission lives
 * in the host adapter; each response and policy receive the same fresh nonce. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appCsp, cspNonce } from "@/lib/security/csp";
import { getEnv } from "@/lib/env";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const nonce = cspNonce();
  const template = await readFile(path.join(process.cwd(), "public/_nexus/app/index.html"), "utf8");
  return new Response(template.replaceAll("__NEXUS_NONCE__", nonce), { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": appCsp({ nonce, dev: false, https: true, ws: [], connect: getEnv().connectOrigins }),
  } });
}
