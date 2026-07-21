import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ messageId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { messageId } = await params;
  return proxyToFastAPI(req, `/messages/${messageId}/rerun`);
}
