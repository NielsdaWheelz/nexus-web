import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ buildHandle: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { buildHandle } = await params;
  return proxyToFastAPI(
    req,
    `/artifact-builds/${encodeURIComponent(buildHandle)}/cancel`,
  );
}
