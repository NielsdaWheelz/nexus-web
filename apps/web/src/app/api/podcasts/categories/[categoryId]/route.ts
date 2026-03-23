import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ categoryId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { categoryId } = await params;
  return proxyToFastAPI(req, `/podcasts/categories/${categoryId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { categoryId } = await params;
  return proxyToFastAPI(req, `/podcasts/categories/${categoryId}`);
}
