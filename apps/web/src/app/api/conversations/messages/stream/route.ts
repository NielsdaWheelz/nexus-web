import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * SSE streaming endpoint for sending messages to new conversations.
 * Must NOT read request body (forwarded as raw bytes by proxy).
 * Must NOT JSON-parse or wrap response.
 */
export async function POST(req: Request) {
  return proxyToFastAPI(req, "/conversations/messages/stream", {
    expectStream: true,
  });
}
