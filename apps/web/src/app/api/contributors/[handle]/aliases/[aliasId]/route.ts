import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ handle: string; aliasId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { handle, aliasId } = await params;
  return proxyToFastAPI(
    req,
    `/contributors/${encodeURIComponent(handle)}/aliases/${encodeURIComponent(aliasId)}`,
  );
}
