import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { formFailure, readAuthForm } from "@/lib/auth/form";
import { finish, redirectTo } from "@/lib/auth/session";
import { parseReturnTarget } from "@/lib/auth/urls";
import { signInWithPassword } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// 303 to the return target with the new session; else {kind} for the form.
export async function POST(request: Request): Promise<NextResponse> {
  const form = await readAuthForm(request, ["email", "password"], ["next"]);
  if (form instanceof NextResponse) return form;
  const { outcome, writes } = await signInWithPassword(
    (await cookies()).getAll(),
    form.email,
    form.password,
  );
  if (outcome !== "SignedIn") return formFailure(outcome);
  return finish(redirectTo(parseReturnTarget(form.next), 303), {
    kind: "Write",
    writes,
  });
}
