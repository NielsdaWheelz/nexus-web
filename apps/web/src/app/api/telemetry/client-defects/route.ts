// A render-crash report, sent as a beacon (no headers of its own). The bff
// adds the release and names its own wire, so a stale tab's crash still lands.
import { proxySession } from "@/lib/api/proxy";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { vercelSourceSha } from "@/lib/env";
import { isRecord } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let report: unknown = null;
  try {
    report = JSON.parse(await request.text());
  } catch {
    // not json: refused below like any other non-object
  }
  if (!isRecord(report)) {
    return Response.json(
      { error: { code: "E_INVALID_REQUEST", message: "Invalid report" } },
      { status: 400 },
    );
  }
  const headers = new Headers(request.headers);
  headers.set("x-nexus-wire", String(WIRE_REVISION));
  const forwarded = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...report, release: vercelSourceSha() }),
    signal: request.signal,
  });
  return proxySession(forwarded, "/telemetry/client-defects", "Json");
}
