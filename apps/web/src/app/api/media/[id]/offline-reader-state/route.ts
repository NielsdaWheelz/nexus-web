import { proxyOfflineReaderProgressToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyOfflineReaderProgressToFastAPI(
    req,
    `/media/${id}/offline-reader-state`,
  );
}

export async function PUT(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyOfflineReaderProgressToFastAPI(
    req,
    `/media/${id}/offline-reader-state`,
  );
}
