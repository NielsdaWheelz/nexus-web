import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  return proxyToFastAPI(req, "/synapse/scans");
}

export async function POST(req: Request) {
  return proxyToFastAPI(req, "/synapse/scans");
}
