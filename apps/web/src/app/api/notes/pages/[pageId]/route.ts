import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ pageId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { pageId } = await params;
  return proxyToFastAPI(req, `/notes/pages/${pageId}`);
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { pageId } = await params;
  return proxyToFastAPI(req, `/notes/pages/${pageId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { pageId } = await params;
  return proxyToFastAPI(req, `/notes/pages/${pageId}`);
}
