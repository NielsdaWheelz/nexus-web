import { proxyToFastAPI } from "@/lib/api/proxy";
import { vercelSourceSha } from "@/lib/env";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const report = await request.json();
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({ ...report, release: vercelSourceSha() }),
    signal: request.signal,
  });
  return proxyToFastAPI(forwarded, "/telemetry/client-defects");
}
