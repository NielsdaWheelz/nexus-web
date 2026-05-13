import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ handle: string; externalIdId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { handle, externalIdId } = await params;
  return proxyToFastAPI(
    req,
    `/contributors/${encodeURIComponent(handle)}/external-ids/${encodeURIComponent(externalIdId)}`,
  );
}
