import { type CookieToSet } from "@/lib/supabase/types";
import { type NextResponse } from "next/server";

/** Apply Supabase rotated session cookies onto a response. The one writer of
 *  the rotated-cookie loop, shared by the BFF proxy and the auth/refresh route. */
export function applyRotatedCookies(
  response: NextResponse,
  cookiesToSet: CookieToSet[]
): void {
  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options);
  }
}
