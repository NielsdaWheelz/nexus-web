import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string }>;

export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(
    request,
    `/internal/media/${id}/offline-reading-token`,
  );
}
