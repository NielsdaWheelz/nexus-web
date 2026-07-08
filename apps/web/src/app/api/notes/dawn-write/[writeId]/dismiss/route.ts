import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ writeId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { writeId } = await params;
  return proxyToFastAPI(req, `/notes/dawn-write/${writeId}/dismiss`);
}
