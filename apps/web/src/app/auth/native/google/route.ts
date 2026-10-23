// credential manager mints a one-use handoff only. no app cookies are read,
// installed or cleared here; the device session owner redeems it separately.
import { NextResponse } from 'next/server';
import { mintHandoffCode } from '@/lib/auth/internal';
import { finish } from '@/lib/auth/session';
import { admitNativeRequest, nativeError } from '@/lib/native/server';
import { AuthUnavailable, signInWithGoogleIdToken } from '@/lib/supabase/auth';
import { isRecord } from '@/lib/validation';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  const rejected = admitNativeRequest(request);
  if (rejected) return rejected;
  let body: unknown;
  try { body = await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid Google sign-in request');
  }
  if (!isRecord(body) || Object.keys(body).sort().join(',') !== 'hc,id_token,nonce' ||
      typeof body.id_token !== 'string' || !body.id_token || typeof body.nonce !== 'string' || !body.nonce ||
      typeof body.hc !== 'string' || !/^[a-f0-9]{64}$/.test(body.hc)) {
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid Google sign-in request');
  }
  try {
    const { tokens } = await signInWithGoogleIdToken([], body.id_token, body.nonce);
    if (!tokens) return nativeError(401, 'E_HANDOFF_FAILED', 'Google sign-in failed');
    const code = await mintHandoffCode(tokens, body.hc);
    return code ? finish(NextResponse.json({ data: { code } })) : nativeError(401, 'E_HANDOFF_FAILED', 'Sign in again');
  } catch (error) {
    if (error instanceof AuthUnavailable) return nativeError(503, 'E_AUTH_UNAVAILABLE', 'Authentication service unavailable');
    // justify-defect: log the contract violation and retain the json boundary.
    console.error('native_google_defect', error);
    return nativeError(500, 'E_INTERNAL', 'Authentication failed');
  }
}
