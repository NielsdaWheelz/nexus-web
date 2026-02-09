/**
 * DEPRECATED (PR-08): BFF streaming proxy for new conversations.
 *
 * Browsers now connect directly to fastapi for SSE streaming.
 * Use POST /api/stream-token to get a direct streaming URL instead.
 *
 * This route returns 410 Gone. Will be deleted in a follow-up.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error: {
        code: "E_DEPRECATED",
        message:
          "This streaming endpoint is deprecated. Use POST /api/stream-token to get a direct streaming URL.",
      },
    },
    { status: 410 }
  );
}
