import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ subjectScheme: string; subjectHandle: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { subjectScheme, subjectHandle } = await params;
  return proxyToFastAPI(
    req,
    `/artifacts/dossiers/${encodeURIComponent(subjectScheme)}/${encodeURIComponent(subjectHandle)}`,
  );
}
