import { proxyToFastAPI } from "@/lib/api/proxy";
import { vercelSourceSha } from "@/lib/env";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const report = await request.json();
  const forwarded = new Request(request, {
    body: JSON.stringify({ ...report, release: vercelSourceSha() }),
  });
  return proxyToFastAPI(forwarded, "/telemetry/client-defects");
}
