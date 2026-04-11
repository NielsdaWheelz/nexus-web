/**
 * BFF route for highlight annotations.
 *
 * Proxies:
 * - PUT /api/highlights/{highlightId}/annotation → FastAPI
 * - DELETE /api/highlights/{highlightId}/annotation → FastAPI
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §10
 */

import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ highlightId: string }>;

export async function PUT(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(req, `/highlights/${highlightId}/annotation`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(req, `/highlights/${highlightId}/annotation`);
}
