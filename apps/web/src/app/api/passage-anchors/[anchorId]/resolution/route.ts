import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ anchorId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { anchorId } = await params;
  return proxyToFastAPI(
    req,
    `/passage-anchors/${encodeURIComponent(anchorId)}/resolution`,
  );
}
