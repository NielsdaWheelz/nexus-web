import { proxyConsumptionRead } from "@/lib/consumption/historyBff.server";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return proxyConsumptionRead(request, "/consumption/sessions");
}
