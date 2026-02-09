/**
 * BFF endpoint for minting stream tokens.
 *
 * Per PR-08 spec §10:
 * - POST /api/stream-token — proxies to fastapi POST /internal/stream-tokens
 * - Returns { token, stream_base_url, expires_at }
 * - Requires authenticated session (supabase cookie auth)
 */

import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Mint a stream token for direct browser→fastapi SSE connections.
 */
export async function POST(req: Request) {
  return proxyToFastAPI(req, "/internal/stream-tokens");
}
