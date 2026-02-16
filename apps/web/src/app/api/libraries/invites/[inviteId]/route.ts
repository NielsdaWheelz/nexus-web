import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ inviteId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { inviteId } = await params;
  return proxyToFastAPI(req, `/libraries/invites/${inviteId}`);
}
