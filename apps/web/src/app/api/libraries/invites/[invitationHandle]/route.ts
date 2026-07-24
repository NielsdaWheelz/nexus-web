import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ invitationHandle: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { invitationHandle } = await params;
  return proxyToFastAPI(
    req,
    `/libraries/invites/${encodeURIComponent(invitationHandle)}`,
  );
}
