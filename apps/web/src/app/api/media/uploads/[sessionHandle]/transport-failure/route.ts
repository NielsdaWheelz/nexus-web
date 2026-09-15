import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ sessionHandle: string }>;

export async function POST(request: Request, { params }: { params: Params }) {
  const { sessionHandle } = await params;
  return proxyToFastAPI(request, `/media/uploads/${encodeURIComponent(sessionHandle)}/transport-failure`);
}
