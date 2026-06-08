import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; revisionId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { id, revisionId } = await params;
  return proxyToFastAPI(
    req,
    `/libraries/${id}/intelligence/revisions/${revisionId}/promote`,
  );
}
