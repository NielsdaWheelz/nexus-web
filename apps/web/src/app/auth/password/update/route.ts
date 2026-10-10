import { NextResponse } from "next/server";
import { formFailure, readAuthForm } from "@/lib/auth/form";
import { ended, finish, liveSession, redirectTo } from "@/lib/auth/session";
import { parseReturnTarget, savedPasswordPath } from "@/lib/auth/urls";
import { AuthUnavailable, updatePassword } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// the viewer sets or replaces the password of the account email. the session
// is refreshed inline when needed; the provider verifies the token as part of
// the write. 303 to /account/password?saved=1[&next].
export async function POST(request: Request): Promise<NextResponse> {
  const form = await readAuthForm(request, ["password"], ["next"]);
  if (form instanceof NextResponse) return form;
  // the provider enforces the same minimum (supabase minimum_password_length).
  if (form.password.length < 15) return formFailure("PolicyRejected");

  let live;
  try {
    live = await liveSession();
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return formFailure("ServiceUnavailable");
  }
  if (live.kind === "Anonymous") return formFailure("SessionEnded");
  if (live.kind === "Ended") {
    return formFailure("SessionEnded", ended(live.cookieNames));
  }

  let result;
  try {
    result = await updatePassword(live.cookies, form.password);
  } catch (error) {
    // justify-defect: logged and answered 500, but a refresh token already
    // spent must still reach the browser.
    console.error("auth_password_update_defect", error);
    return finish(
      NextResponse.json({ error: { code: "E_INTERNAL" } }, { status: 500 }),
      { kind: "Write", writes: live.writes },
    );
  }
  const writes = [...live.writes, ...result.writes];
  if (result.outcome === "SessionEnded") {
    const names = [...live.cookieNames, ...result.writes.map((w) => w.name)];
    return formFailure("SessionEnded", ended(names));
  }
  if (result.outcome !== "Saved") {
    return formFailure(result.outcome, { kind: "Write", writes });
  }
  const saved = savedPasswordPath(parseReturnTarget(form.next));
  return finish(redirectTo(saved, 303), { kind: "Write", writes });
}
