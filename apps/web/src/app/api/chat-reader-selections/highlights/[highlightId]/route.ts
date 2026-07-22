import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ highlightId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { highlightId } = await params;
  return proxyToFastAPI(
    req,
    `/chat-reader-selections/highlights/${highlightId}`
  );
}
