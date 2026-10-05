import { NextResponse } from "next/server";
import { vercelSourceSha } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET(): NextResponse<{ source_sha: string }> {
  return NextResponse.json(
    { source_sha: vercelSourceSha() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
