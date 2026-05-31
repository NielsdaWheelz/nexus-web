import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ fragmentId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { fragmentId } = await params;
  return proxyToFastAPI(req, `/fragments/${fragmentId}/highlights`);
}

export async function POST(req: Request, { params }: { params: Params }) {
  const { fragmentId } = await params;
  return proxyToFastAPI(req, `/fragments/${fragmentId}/highlights`);
}
