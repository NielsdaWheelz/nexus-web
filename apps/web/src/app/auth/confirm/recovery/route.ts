import { NextResponse } from "next/server";
import { handleEmailConfirmation } from "@/lib/auth/email-confirmation-route";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  return handleEmailConfirmation(request, "recovery");
}
