import { postActivity } from "@/lib/consumption/historyBff.server";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return postActivity(request);
}
