import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { formFailure, readAuthForm } from "@/lib/auth/form";
import { finish, redirectTo } from "@/lib/auth/session";
import { confirmEmailLink } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// spend an invite or recovery token_hash (the landing's GET never does) and
// continue to /account/password with the session it establishes.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ purpose: string }> },
): Promise<NextResponse> {
  const { purpose } = await params;
  if (purpose !== "invite" && purpose !== "recovery") {
    return finish(new NextResponse(null, { status: 404 }));
  }
  const form = await readAuthForm(request, ["token_hash"]);
  if (form instanceof NextResponse) return form;
  const { outcome, writes } = await confirmEmailLink(
    (await cookies()).getAll(),
    purpose,
    form.token_hash,
  );
  if (outcome !== "Confirmed") return formFailure(outcome);
  return finish(redirectTo("/account/password", 303), {
    kind: "Write",
    writes,
  });
}
