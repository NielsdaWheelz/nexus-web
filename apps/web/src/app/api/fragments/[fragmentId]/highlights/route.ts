/**
 * BFF route for fragment highlights.
 *
 * Proxies:
 * - POST /api/fragments/{fragmentId}/highlights → FastAPI
 * - GET /api/fragments/{fragmentId}/highlights → FastAPI
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §7.5
 */

import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ fragmentId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { fragmentId } = await params;
  return proxyToFastAPI(req, `/fragments/${fragmentId}/highlights`);
}

export async function POST(req: Request, { params }: { params: Params }) {
  const { fragmentId } = await params;
  return proxyToFastAPI(req, `/fragments/${fragmentId}/highlights`);
}
