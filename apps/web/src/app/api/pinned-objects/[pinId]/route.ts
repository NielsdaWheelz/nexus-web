import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ pinId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { pinId } = await params;
  return proxyToFastAPI(req, `/pinned-objects/${pinId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { pinId } = await params;
  return proxyToFastAPI(req, `/pinned-objects/${pinId}`);
}
