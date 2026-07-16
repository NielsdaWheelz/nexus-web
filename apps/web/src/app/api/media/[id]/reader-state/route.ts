import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

// Reader-state responses are never cacheable: the cursor is revalidated
// event-driven and a cached snapshot would defeat revision arbitration. The
// header is stamped on proxied AND locally generated (proxy-error) responses,
// mirroring the exact-path FastAPI middleware.
const READER_STATE_CACHE_CONTROL = "private, no-store";

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", READER_STATE_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return withNoStore(await proxyToFastAPI(req, `/media/${id}/reader-state`));
}

export async function PUT(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return withNoStore(await proxyToFastAPI(req, `/media/${id}/reader-state`));
}
