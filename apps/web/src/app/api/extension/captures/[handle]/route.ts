import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Context = { params: Promise<{ handle: string }> };

async function capturePath({ params }: Context): Promise<string> {
  const { handle } = await params;
  return `/extension/captures/${encodeURIComponent(handle)}`;
}

export async function GET(req: Request, context: Context) {
  return proxyExtensionToFastAPI(req, await capturePath(context));
}

export async function DELETE(req: Request, context: Context) {
  return proxyExtensionToFastAPI(req, await capturePath(context));
}
