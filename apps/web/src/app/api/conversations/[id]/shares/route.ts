import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/shares`);
}

export async function PUT(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/shares`);
}
