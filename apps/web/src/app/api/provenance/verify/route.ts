import { verifyProvenancePacket } from "@/lib/conversations/provenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "E_INVALID_JSON",
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  const packet = isRecord(body) && "packet" in body ? body.packet : body;
  const verification = verifyProvenancePacket(packet);
  return Response.json({ data: verification }, { status: verification.ok ? 200 : 422 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
