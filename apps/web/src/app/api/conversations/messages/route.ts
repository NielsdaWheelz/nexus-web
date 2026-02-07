import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Create a new conversation and send a message (non-streaming fallback).
 */
export async function POST(req: Request) {
  return proxyToFastAPI(req, "/conversations/messages");
}
