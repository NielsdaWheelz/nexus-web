import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ artifactRef: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { artifactRef } = await params;
  return proxyToFastAPI(
    req,
    `/artifacts/${encodeURIComponent(artifactRef)}/revisions`,
  );
}
