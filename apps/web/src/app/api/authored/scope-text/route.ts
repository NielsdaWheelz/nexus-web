/** A single bounded authorized text page, with its own publication fence. */
import { proxySession } from "@/lib/api/proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return proxySession(request, "/authored/scope-text", "Json");
}
