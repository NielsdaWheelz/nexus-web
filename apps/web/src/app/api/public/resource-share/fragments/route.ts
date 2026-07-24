import { proxyResourceShareToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyResourceShareToFastAPI(
    request,
    "/public/resource-share/fragments"
  );
}
