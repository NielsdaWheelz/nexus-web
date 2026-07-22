import { proxyToFastAPI } from "@/lib/api/proxy";
import { librarySlateResource } from "@/lib/api/resource";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(
    req,
    librarySlateResource.serverPath({ id, refreshVersion: 0 }),
  );
}
