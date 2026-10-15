// The extension lane: /api/extension/session is the extension's own session;
// every other path is the identically named FastAPI extension path.
import { proxyExtension } from "@/lib/api/proxy";

export const runtime = "nodejs";

async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const path = (await params).path.map(encodeURIComponent).join("/");
  const target =
    path === "session"
      ? "/auth/extension-sessions/current"
      : `/extension/${path}`;
  return proxyExtension(request, target);
}

export { handle as GET, handle as POST, handle as DELETE };
