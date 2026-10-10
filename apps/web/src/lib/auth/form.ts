// the four same-origin auth form posts (sign-in, recovery request, password
// update, email link): admission (Origin = APP_PUBLIC_URL), exact string
// fields, and the {kind} failure body each form renders. success is always a
// 303 the client follows itself.
import "server-only";

import { NextResponse } from "next/server";
import { finish, isSameOrigin, type Effect } from "@/lib/auth/session";

const STATUS = {
  Forbidden: 403,
  InvalidRequest: 400,
  InvalidCredentials: 401,
  SessionEnded: 401,
  PolicyRejected: 400,
  InvalidOrExpired: 400,
  RateLimited: 429,
  ServiceUnavailable: 503,
} as const;

export type FormFailure = keyof typeof STATUS;

export function formFailure(kind: FormFailure, effect?: Effect): NextResponse {
  return finish(NextResponse.json({ kind }, { status: STATUS[kind] }), effect);
}

// exactly the named string fields, each at most once, the required ones
// non-empty (not trimmed: a whitespace password is a password); anything else
// is InvalidRequest. a post from another origin is Forbidden before the body
// is read.
export async function readAuthForm<
  Required extends string,
  Optional extends string = never,
>(
  request: Request,
  required: readonly Required[],
  optional: readonly Optional[] = [],
): Promise<
  (Record<Required, string> & Partial<Record<Optional, string>>) | NextResponse
> {
  if (!isSameOrigin(request)) return formFailure("Forbidden");
  let data: FormData;
  try {
    data = await request.formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return formFailure("InvalidRequest");
  }
  const allowed: readonly string[] = [...required, ...optional];
  const fields: Record<string, string> = {};
  for (const [key, value] of data) {
    if (!allowed.includes(key) || typeof value !== "string" || key in fields) {
      return formFailure("InvalidRequest");
    }
    fields[key] = value;
  }
  if (!required.every((key) => fields[key]))
    return formFailure("InvalidRequest");
  return fields as Record<Required, string> & Partial<Record<Optional, string>>;
}
