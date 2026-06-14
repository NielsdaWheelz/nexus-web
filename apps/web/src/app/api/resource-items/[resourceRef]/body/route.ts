import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ resourceRef: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { resourceRef } = await params;
  return proxyToFastAPI(
    req,
    `/resource-items/${encodeURIComponent(resourceRef)}/body`,
  );
}
