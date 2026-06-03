import { proxyPublicToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyPublicToFastAPI(req, `/oracle/plates/${id}`);
}
