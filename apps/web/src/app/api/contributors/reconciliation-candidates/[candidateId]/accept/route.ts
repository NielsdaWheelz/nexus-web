import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ candidateId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { candidateId } = await params;
  return proxyToFastAPI(
    req,
    `/contributors/reconciliation-candidates/${encodeURIComponent(candidateId)}/accept`,
  );
}
