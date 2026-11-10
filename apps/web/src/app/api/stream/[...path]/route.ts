// Only chat owns a streaming lifetime. Retired paths keep the session/wire error
// boundary and receive finite structured refusals from the API.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const target = `/stream/${path.map(encodeURIComponent).join("/")}`;
  const chat = path.length === 3 && path[0] === "chat-runs" && path[2] === "events";
  return proxySession(request, target, chat ? "Stream" : "Json");
}
