import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ handle: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { handle } = await params;
  return proxyToFastAPI(
    req,
    `/contributors/${encodeURIComponent(handle)}/aliases`,
  );
}
