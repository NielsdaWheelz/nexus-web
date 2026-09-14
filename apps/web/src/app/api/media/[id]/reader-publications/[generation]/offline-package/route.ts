import { proxyAccountBoundToFastAPI } from "@/lib/api/proxy";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";

export const runtime = "nodejs";

type Params = Promise<{ id: string; generation: string }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const { id, generation } = await params;
  return privateNoStoreResponse(
    await proxyAccountBoundToFastAPI(
      request,
      `/media/${encodeURIComponent(id)}/reader-publications/${encodeURIComponent(generation)}/offline-package`,
    ),
  );
}
