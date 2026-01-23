/**
 * BFF route for fragment highlights.
 *
 * Proxies:
 * - POST /api/fragments/{fragmentId}/highlights → FastAPI
 * - GET /api/fragments/{fragmentId}/highlights → FastAPI
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §7.5
 */

import { NextRequest } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fragmentId: string }> }
) {
  const { fragmentId } = await params;
  return proxyToFastAPI(request, `/fragments/${fragmentId}/highlights`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fragmentId: string }> }
) {
  const { fragmentId } = await params;
  return proxyToFastAPI(request, `/fragments/${fragmentId}/highlights`);
}
