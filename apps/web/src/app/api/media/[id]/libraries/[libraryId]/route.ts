import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; libraryId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id, libraryId } = await params;
  return proxyToFastAPI(req, `/media/${id}/libraries/${libraryId}`);
}
