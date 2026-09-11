import { proxyToFastAPI } from "@/lib/api/proxy";
import { vercelSourceSha } from "@/lib/env";
import {
  decodeClientDefectReport,
  type ClientDefectReport,
} from "@/lib/telemetry/clientDefects";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  let report: ClientDefectReport;
  try {
    report = decodeClientDefectReport(await request.json());
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof SyntaxError))
      throw error;
    return Response.json(
      {
        error: {
          code: "E_BAD_REQUEST",
          message: "Invalid client defect report",
        },
      },
      { status: 400 },
    );
  }
  const forwarded = new Request(request, {
    body: JSON.stringify({ ...report, release: vercelSourceSha() }),
  });
  return proxyToFastAPI(forwarded, "/telemetry/client-defects");
}
