// the response owner for fixed account operations. email sends are never
// retried; unlink is idempotent. publish renewal first even if the operation
// fails, and retain provider session/pkce writes on the same response.
import 'server-only';
import { NextResponse } from 'next/server';
import { ended, finish, liveSession } from '@/lib/auth/session';
import { admitNativeRequest, nativeError } from '@/lib/native/server';
import { AuthUnavailable, type CookieWrite } from '@/lib/supabase/auth';
import type { CookieValue } from '@/lib/supabase/cookie';

export async function settingsOperation(request: Request, operation: (
  cookies: readonly CookieValue[],
) => Promise<{ outcome: string; writes: readonly CookieWrite[]; data?: unknown }>): Promise<NextResponse> {
  const rejected = admitNativeRequest(request);
  if (rejected) return rejected;
  let live;
  try { live = await liveSession(); }
  catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return nativeError(503, 'E_AUTH_UNAVAILABLE', 'Authentication service unavailable');
  }
  if (live.kind === 'Anonymous') return nativeError(401, 'E_UNAUTHENTICATED', 'Sign in to reconnect');
  if (live.kind === 'Ended') return finish(nativeError(401, 'E_UNAUTHENTICATED', 'Sign in to reconnect'), ended(live.cookieNames));
  try {
    const result = await operation(live.cookies);
    if (result.outcome === 'SessionEnded') {
      return finish(nativeError(401, 'E_UNAUTHENTICATED', 'Sign in to reconnect'), ended([...live.cookieNames, ...result.writes.map(w => w.name)]));
    }
    return finish(NextResponse.json({ data: result.data ?? { outcome: result.outcome } }), { kind: 'Write', writes: [...live.writes, ...result.writes] });
  } catch (error) {
    if (error instanceof AuthUnavailable) return finish(nativeError(503, 'E_AUTH_UNAVAILABLE', 'Authentication service unavailable'), { kind: 'Write', writes: live.writes });
    // justify-defect: retain rotation if a provider operation violates its contract.
    console.error('account_settings_operation_failed', error);
    return finish(nativeError(500, 'E_INTERNAL', 'Account operation failed'), { kind: 'Write', writes: live.writes });
  }
}
