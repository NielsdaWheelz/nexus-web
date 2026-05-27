import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ libraryId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { libraryId } = await params;
  return proxyToFastAPI(req, `/chat-singletons/library/${libraryId}`);
}
