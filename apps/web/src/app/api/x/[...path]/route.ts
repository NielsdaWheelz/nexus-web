// The closed capture namespace uses the session JSON or archived-asset lane.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const get = request.method === "GET";
  const asset = get && path.length === 4 && path[2] === "assets";
  const json = path.length === 3 && (
    (get && ["reader", "archive", "document-map"].includes(path[2])) ||
    (request.method === "POST" && path[2] === "retry-images")
  );
  if (path[0] !== "captures" || (!asset && !json)) {
    return Response.json({ error: { code: "E_NOT_FOUND", message: "Not found" } }, { status: 404 });
  }
  return proxySession(request, `/x/${path.map(encodeURIComponent).join("/")}`, asset ? "Asset" : "Json");
}

export { handle as GET, handle as POST };
