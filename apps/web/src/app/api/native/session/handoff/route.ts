// one-use redemption: a lost response requires a new sign-in. verify both the
// consumed bearer and installed successor BEFORE publishing any cookie effect.
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { consumeHandoffCode } from '@/lib/auth/internal';
import { finish } from '@/lib/auth/session';
import { admitNativeRequest, nativeError } from '@/lib/native/server';
import { AuthUnavailable, installSession, verify } from '@/lib/supabase/auth';
import { isRecord } from '@/lib/validation';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  const rejected = admitNativeRequest(request);
  if (rejected) return rejected;
  let body: unknown;
  try { body = await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid handoff request');
  }
  if (!isRecord(body) || Object.keys(body).sort().join(',') !== 'code,expected_account_id,verifier' ||
      typeof body.code !== 'string' || !body.code || typeof body.verifier !== 'string' || !body.verifier ||
      (body.expected_account_id !== null && typeof body.expected_account_id !== 'string')) {
    return nativeError(400, 'E_INVALID_REQUEST', 'Invalid handoff request');
  }
  const failed = () => nativeError(401, 'E_HANDOFF_FAILED', 'Sign in again');
  const mismatch = () => nativeError(409, 'E_DIFFERENT_ACCOUNT', 'Use the account already open here');
  try {
    const tokens = await consumeHandoffCode(body.code, body.verifier);
    if (!tokens) return failed();
    const viewer = await verify(tokens.accessToken);
    if (viewer === 'Rejected') return failed();
    if (body.expected_account_id !== null && body.expected_account_id !== viewer.userId) return mismatch();
    const installed = await installSession((await cookies()).getAll(), tokens);
    if (!installed.tokens) return failed();
    const successor = await verify(installed.tokens.accessToken);
    if (successor === 'Rejected') return failed();
    if (successor.userId !== viewer.userId) return mismatch();
    return finish(NextResponse.json({ data: { account_id: successor.userId } }), { kind: 'Write', writes: installed.writes });
  } catch (error) {
    if (error instanceof AuthUnavailable) return nativeError(503, 'E_AUTH_UNAVAILABLE', 'Authentication service unavailable');
    // justify-defect: log the contract violation and retain the json boundary.
    console.error('native_handoff_defect', error);
    return nativeError(500, 'E_INTERNAL', 'Authentication failed');
  }
}
