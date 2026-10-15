// Event streams through the session lane. The bff ends each one cleanly before
// maxDuration and the client resumes from its cursor.
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
  return proxySession(request, target, "Stream");
}
