import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";
import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return privateNoStoreResponse(
    await proxyToFastAPI(req, `/media/${id}/offline-download-spec`)
  );
}
