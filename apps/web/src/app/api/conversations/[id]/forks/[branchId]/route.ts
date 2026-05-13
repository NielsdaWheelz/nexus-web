import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string; branchId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { id, branchId } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/forks/${branchId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id, branchId } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/forks/${branchId}`);
}
