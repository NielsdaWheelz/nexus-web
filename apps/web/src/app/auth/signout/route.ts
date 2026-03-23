import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const { supabase, applyCookies } = await createRouteHandlerClient();

  // Local scope signs the current browser session out without revoking other devices.
  await supabase.auth.signOut({ scope: "local" });

  return applyCookies(
    NextResponse.redirect(`${requestUrl.origin}/login`, {
      status: 302,
    })
  );
}
