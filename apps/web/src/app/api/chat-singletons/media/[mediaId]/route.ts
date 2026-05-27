import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ mediaId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { mediaId } = await params;
  return proxyToFastAPI(req, `/chat-singletons/media/${mediaId}`);
}
