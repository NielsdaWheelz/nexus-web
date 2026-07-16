import { NextResponse } from "next/server";

import { proxyToFastAPI } from "@/lib/api/proxy";
import { contributorResource } from "@/lib/api/resource";
import { RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS } from "@/lib/contributors/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ handle: string }>;

// Reserved collection segments (`directory`, `reconciliation-candidates`) are shadowed by
// this `[handle]` route once their sibling static routes are gone; short-circuit them to 404
// so the BFF never proxies a reserved word upstream as an author handle.
function reservedSegment404(): NextResponse {
  return NextResponse.json(
    { error: { code: "E_NOT_FOUND", message: "Not found" } },
    { status: 404 },
  );
}

export async function GET(req: Request, { params }: { params: Params }) {
  const { handle } = await params;
  if (RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has(handle)) return reservedSegment404();
  return proxyToFastAPI(req, contributorResource.serverPath({ handle }));
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { handle } = await params;
  if (RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has(handle)) return reservedSegment404();
  return proxyToFastAPI(req, contributorResource.serverPath({ handle }));
}
