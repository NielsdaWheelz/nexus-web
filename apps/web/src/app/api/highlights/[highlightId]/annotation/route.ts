/**
 * BFF route for highlight annotations.
 *
 * Proxies:
 * - PUT /api/highlights/{highlightId}/annotation → FastAPI
 * - DELETE /api/highlights/{highlightId}/annotation → FastAPI
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §10
 */

import { NextRequest } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ highlightId: string }> }
) {
  const { highlightId } = await params;
  return proxyToFastAPI(request, `/highlights/${highlightId}/annotation`);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ highlightId: string }> }
) {
  const { highlightId } = await params;
  return proxyToFastAPI(request, `/highlights/${highlightId}/annotation`);
}
