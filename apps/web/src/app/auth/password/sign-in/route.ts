// password handoff mints for the CURRENT native attempt; browser sign-in
// installs normally. a failed mint requires an explicit new submission.
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { formFailure, readAuthForm } from '@/lib/auth/form';
import { mintHandoffCode } from '@/lib/auth/internal';
import { finish, redirectTo } from '@/lib/auth/session';
import { handoffDeepLink, parseHandoffContext, parseReturnTarget } from '@/lib/auth/urls';
import { AuthUnavailable, signInWithPassword } from '@/lib/supabase/auth';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  const form = await readAuthForm(request, ['email', 'password'], ['next', 'flow', 'hc']);
  if (form instanceof NextResponse) return form;
  const handoff = parseHandoffContext(form.flow, form.hc);
  if ((form.flow !== undefined || form.hc !== undefined) && handoff === null) return formFailure('InvalidRequest');
  const { outcome, writes, tokens } = await signInWithPassword(handoff ? [] : (await cookies()).getAll(), form.email, form.password);
  if (outcome !== 'SignedIn') return formFailure(outcome);
  const target = parseReturnTarget(form.next);
  if (handoff) {
    try {
      const code = tokens && await mintHandoffCode(tokens, handoff.challenge);
      if (!code) return formFailure('ServiceUnavailable');
      return finish(NextResponse.json({ kind: 'Handoff', handoff_url: handoffDeepLink({ code }, target, handoff) }));
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      return formFailure('ServiceUnavailable');
    }
  }
  return finish(redirectTo(target, 303), { kind: 'Write', writes });
}
