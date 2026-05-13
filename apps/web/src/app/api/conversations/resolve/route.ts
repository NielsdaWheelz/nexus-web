import { proxyToFastAPI } from "@/lib/api/proxy";

export async function POST(req: Request) {
  return proxyToFastAPI(req, "/conversations/resolve");
}
