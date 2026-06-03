import { proxyToFastAPI } from "@/lib/api/proxy";
import { contributorWorksResource } from "@/lib/api/resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ handle: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { handle } = await params;
  return proxyToFastAPI(
    req,
    contributorWorksResource.serverPath({ handle }),
  );
}
