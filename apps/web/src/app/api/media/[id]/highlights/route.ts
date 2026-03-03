import { proxyToFastAPI } from "@/lib/api/proxy";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/media/${id}/highlights`);
}
