/**
 * BFF route for individual highlight operations.
 *
 * Proxies:
 * - GET /api/highlights/{highlightId} → FastAPI
 * - PATCH /api/highlights/{highlightId} → FastAPI
 * - DELETE /api/highlights/{highlightId} → FastAPI
 */

import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ highlightId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(req, `/highlights/${highlightId}`);
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(req, `/highlights/${highlightId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(req, `/highlights/${highlightId}`);
}
