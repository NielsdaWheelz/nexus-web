import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ keyId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { keyId } = await params;
  return proxyToFastAPI(req, `/keys/${keyId}/test`);
}
