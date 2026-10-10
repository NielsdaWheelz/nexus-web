import { NextResponse } from "next/server";
import { formFailure, readAuthForm } from "@/lib/auth/form";
import { finish, redirectTo } from "@/lib/auth/session";
import { requestRecovery } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// "Requested" for every address, known or not (no enumeration).
export async function POST(request: Request): Promise<NextResponse> {
  const form = await readAuthForm(request, ["email"]);
  if (form instanceof NextResponse) return form;
  const outcome = await requestRecovery(form.email);
  if (outcome !== "Requested") return formFailure(outcome);
  return finish(redirectTo("/forgot-password?sent=1", 303));
}
