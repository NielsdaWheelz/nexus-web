import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  return proxyExtensionToFastAPI(
    req,
    `/extension/captures/${encodeURIComponent(handle)}/retry`,
  );
}
