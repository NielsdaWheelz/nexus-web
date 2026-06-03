import { proxyToFastAPI } from "@/lib/api/proxy";
import { libraryResource } from "@/lib/api/resource";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, libraryResource.serverPath({ id }));
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, libraryResource.serverPath({ id }));
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, libraryResource.serverPath({ id }));
}
