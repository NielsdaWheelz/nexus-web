/**
 * BFF route for individual highlight operations.
 *
 * Proxies:
 * - GET /api/highlights/{highlightId} → FastAPI
 * - PATCH /api/highlights/{highlightId} → FastAPI
 * - DELETE /api/highlights/{highlightId} → FastAPI
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §8
 */

import { NextRequest } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ highlightId: string }> }
) {
  const { highlightId } = await params;
  return proxyToFastAPI(request, `/highlights/${highlightId}`);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ highlightId: string }> }
) {
  const { highlightId } = await params;
  return proxyToFastAPI(request, `/highlights/${highlightId}`);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ highlightId: string }> }
) {
  const { highlightId } = await params;
  return proxyToFastAPI(request, `/highlights/${highlightId}`);
}
