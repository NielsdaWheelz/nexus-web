import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

const REQUEST_PATH_HEADER = "x-nexus-request-path";

export async function requireAuthenticatedUser() {
  const supabase = await createClient();

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      return;
    }
  } catch (error) {
    console.error("Protected route auth check failed:", error);
  }

  const requestPath =
    (await headers()).get(REQUEST_PATH_HEADER) ?? DEFAULT_AUTH_REDIRECT;
  const nextPath = normalizeAuthRedirect(requestPath, DEFAULT_AUTH_REDIRECT);
  redirect(`/login?next=${encodeURIComponent(nextPath)}`);
}
