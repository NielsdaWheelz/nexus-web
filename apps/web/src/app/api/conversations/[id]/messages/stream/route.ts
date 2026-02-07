import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string }>;

/**
 * SSE streaming endpoint for sending messages to existing conversations.
 * Must NOT read request body (forwarded as raw bytes by proxy).
 * Must NOT JSON-parse or wrap response.
 */
export async function POST(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/messages/stream`, {
    expectStream: true,
  });
}
