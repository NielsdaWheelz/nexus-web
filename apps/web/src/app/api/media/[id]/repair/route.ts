import { proxyToFastAPI } from "@/lib/api/proxy";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return privateNoStoreResponse(
    await proxyToFastAPI(request, `/media/${encodeURIComponent(id)}/repair`),
  );
}
