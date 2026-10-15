// The apk's offline reading copy: FastAPI builds it into object storage and
// answers a signed url, which can take minutes for a large book.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const target = `/media/${encodeURIComponent(id)}/reading-copy`;
  return proxySession(request, target, "Copy");
}
