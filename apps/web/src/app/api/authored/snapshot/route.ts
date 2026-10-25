/** Snapshot bytes stream through the session lane; cancellation closes the
 * backend repeatable-read transaction. Never buffer the corpus as JSON. */
import { proxySession } from "@/lib/api/proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request): Promise<Response> {
  return proxySession(request, "/authored/snapshot", "Stream");
}
