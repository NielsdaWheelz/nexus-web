import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ podcastId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { podcastId } = await params;
  return proxyToFastAPI(req, `/podcasts/${podcastId}/libraries`);
}
