import { proxyToFastAPI } from "@/lib/api/proxy";
import { libraryEntriesResource } from "@/lib/api/resource";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, libraryEntriesResource.serverPath({ id }));
}
