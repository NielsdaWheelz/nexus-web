import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string; evidenceId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id, evidenceId } = await params;
  return proxyToFastAPI(req, `/media/${id}/evidence/${evidenceId}`);
}
