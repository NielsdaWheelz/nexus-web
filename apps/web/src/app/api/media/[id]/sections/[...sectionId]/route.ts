import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; sectionId: string[] }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id, sectionId } = await params;
  const rawSectionId = sectionId.join("/");
  return proxyToFastAPI(req, `/media/${id}/sections/${encodeURIComponent(rawSectionId)}`);
}
