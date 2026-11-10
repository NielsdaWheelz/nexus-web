import { NextResponse } from "next/server";
import { sourceSha } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET(): NextResponse<{ source_sha: string }> {
  return NextResponse.json(
    { source_sha: sourceSha() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
