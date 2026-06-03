import { proxyToFastAPI } from "@/lib/api/proxy";
import { notePagesResource } from "@/lib/api/resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  return proxyToFastAPI(req, notePagesResource.serverPath({}));
}

export async function POST(req: Request) {
  return proxyToFastAPI(req, notePagesResource.serverPath({}));
}
