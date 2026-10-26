/** Bounded derived search metadata; never shares the authored snapshot lifetime. */
import { proxySession } from "@/lib/api/proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return proxySession(request, "/authored/scope-inputs", "Json");
}
