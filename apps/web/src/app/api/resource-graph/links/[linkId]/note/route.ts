import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ linkId: string }>;

export async function PUT(req: Request, { params }: { params: Params }) {
  const { linkId } = await params;
  return proxyToFastAPI(req, `/resource-graph/links/${linkId}/note`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { linkId } = await params;
  return proxyToFastAPI(req, `/resource-graph/links/${linkId}/note`);
}
