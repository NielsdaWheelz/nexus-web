// never retry email sends automatically: a lost answer may already have sent.
import { NextResponse } from 'next/server';
import { settingsOperation } from '@/lib/account/settings.server';
import { callbackPath, parseReturnTarget } from '@/lib/auth/urls';
import { getEnv } from '@/lib/env';
import { admitNativeRequest, nativeError } from '@/lib/native/server';
import { changeEmail } from '@/lib/supabase/auth';
import { isRecord } from '@/lib/validation';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  const rejected = admitNativeRequest(request);
  if (rejected) return rejected;
  let body: unknown;
  try { body = await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid email-change request');
  }
  if (!isRecord(body) || Object.keys(body).join(',') !== 'email' || typeof body.email !== 'string') {
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid email-change request');
  }
  const email = body.email.trim().toLowerCase();
  return settingsOperation(request, async cookies => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { outcome: 'Invalid', writes: [] };
    const callback = callbackPath(parseReturnTarget('/settings/account'), 'email');
    return changeEmail(cookies, email, new URL(callback, getEnv().appPublicOrigin).href);
  });
}
