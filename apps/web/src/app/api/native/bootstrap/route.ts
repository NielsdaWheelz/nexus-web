// verified aggregate for the device credential owner. reads may be repeated;
// rotation/device effects survive any later read failure. no pane seeds.
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/api/client';
import { callFastAPI } from '@/lib/api/server';
import type { ApiJson } from '@/lib/api/wire';
import { resolveDevice } from '@/lib/auth/deviceCookie';
import { ended, finish, resolveEntry } from '@/lib/auth/session';
import type { NativeBootstrap } from '@/lib/native/contracts';
import { admitNativeRequest, nativeError } from '@/lib/native/server';
import { AuthUnavailable } from '@/lib/supabase/auth';
import { refreshAfterMs } from '@/lib/supabase/cookie';
import { enterWorkspace } from '@/lib/workspace/model';

export const runtime = 'nodejs';
export async function GET(request: Request): Promise<NextResponse> {
  const rejected = admitNativeRequest(request);
  if (rejected) return rejected;
  const store = await cookies();
  let live;
  try { live = await resolveEntry(store.getAll()); }
  catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return nativeError(503, 'E_AUTH_UNAVAILABLE', 'Authentication service unavailable');
  }
  if (live.kind === 'Anonymous') return nativeError(401, 'E_UNAUTHENTICATED', 'Sign in to reconnect');
  if (live.kind === 'Ended') return finish(nativeError(401, 'E_UNAUTHENTICATED', 'Sign in to reconnect'), ended(live.cookieNames));
  const device = resolveDevice(store);
  const effect = { kind: 'Write', writes: [...live.writes, ...device.writes] } as const;
  try {
    const context = { accessToken: live.accessToken, deviceId: device.deviceId };
    const [me, profile, sessions] = await Promise.all([
      callFastAPI<ApiJson<'/me', 'get'>>('/me', { context }),
      callFastAPI<ApiJson<'/me/reader-profile', 'get'>>('/me/reader-profile', { context }),
      callFastAPI<ApiJson<'/me/workspace-session', 'get'>>('/me/workspace-session', { context }),
    ]);
    const data: NativeBootstrap = {
      account: { account_id: me.data.user_id, calendar_time_zone: me.data.calendar_time_zone },
      reader_profile: profile.data,
      workspace: enterWorkspace(sessions.data.own, sessions.data.most_recent_elsewhere, null),
      refresh_after_ms: refreshAfterMs(live.cookies),
    };
    return finish(NextResponse.json({ data }), effect);
  } catch (error) {
    if (error instanceof ApiError) return finish(nativeError(error.status || 503, error.code, error.message), effect);
    // justify-defect: preserve a spent refresh token while exposing the defect.
    console.error('native_bootstrap_defect', error);
    return finish(nativeError(500, 'E_INTERNAL', 'Bootstrap failed'), effect);
  }
}
