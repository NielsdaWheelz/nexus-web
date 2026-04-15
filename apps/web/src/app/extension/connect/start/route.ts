import { NextResponse } from "next/server";
import { buildLoginRedirectUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
  const requestUrl = new URL(req.url);
  const redirectUri = requestUrl.searchParams.get("redirect_uri");
  if (!redirectUri) {
    return NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is required" } },
      { status: 400 }
    );
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    return NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is invalid" } },
      { status: 400 }
    );
  }

  const allowedOrigins = (process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (redirectUrl.protocol !== "https:" || !allowedOrigins.includes(redirectUrl.origin)) {
    return NextResponse.json(
      { error: { code: "E_FORBIDDEN", message: "Extension redirect origin is not allowed" } },
      { status: 403 }
    );
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return NextResponse.redirect(buildLoginRedirectUrl(requestUrl));
  }

  const requestId = crypto.randomUUID();
  const response = await fetch(
    `${process.env.FASTAPI_BASE_URL || "http://localhost:8000"}/auth/extension-sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "X-Request-ID": requestId,
        ...(process.env.NEXUS_INTERNAL_SECRET
          ? { "X-Nexus-Internal": process.env.NEXUS_INTERNAL_SECRET }
          : {}),
      },
    }
  );

  if (!response.ok) {
    redirectUrl.hash = new URLSearchParams({
      error: "session_failed",
      request_id: requestId,
    }).toString();
    return NextResponse.redirect(redirectUrl);
  }

  const body = await response.json();
  const token = body?.data?.token;
  if (typeof token !== "string" || !token) {
    redirectUrl.hash = new URLSearchParams({
      error: "session_failed",
      request_id: requestId,
    }).toString();
    return NextResponse.redirect(redirectUrl);
  }

  redirectUrl.hash = new URLSearchParams({ token }).toString();
  return NextResponse.redirect(redirectUrl);
}
