import { NextResponse } from "next/server";
import { postSessionResolution } from "@/lib/auth/session-resolution";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  return postSessionResolution(request);
}
