import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ resourceGrantHandle: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { resourceGrantHandle } = await params;
  return proxyToFastAPI(
    req,
    `/resource-shares/${encodeURIComponent(resourceGrantHandle)}`,
  );
}
