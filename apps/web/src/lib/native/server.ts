// admission for fixed native/json bff routes. wire and mutation origin precede
// body reads, credential rotation and provider effects.
import 'server-only';
import { NextResponse } from 'next/server';
import { WIRE_REVISION } from '@/lib/api/wire.gen';
import { finish, isSameOrigin } from '@/lib/auth/session';
import { createRandomId } from '@/lib/createRandomId';

export function nativeError(status: number, code: string, message: string): NextResponse {
  const request_id = createRandomId();
  return finish(NextResponse.json({ error: { code, message, request_id } }, {
    status, headers: { 'x-request-id': request_id },
  }));
}
export function admitNativeRequest(request: Request): NextResponse | null {
  if (request.headers.get('X-Nexus-Wire') !== String(WIRE_REVISION)) {
    return nativeError(426, 'E_WIRE_MISMATCH', 'Update Nexus to reconnect');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !isSameOrigin(request)) {
    return nativeError(403, 'E_FORBIDDEN', 'Cross-origin request rejected');
  }
  return null;
}
