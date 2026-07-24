import { proxyResourceShareToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ sectionHandle: string }>;

export async function GET(
  request: Request,
  { params }: { params: Params }
) {
  const { sectionHandle } = await params;
  return proxyResourceShareToFastAPI(
    request,
    `/public/resource-share/sections/${encodeURIComponent(sectionHandle)}`
  );
}
