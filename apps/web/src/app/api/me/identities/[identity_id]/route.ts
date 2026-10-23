// idempotent: an already absent identity is Unlinked. the authenticated lookup
// derives its provider; the caller supplies only the identity id.
import { settingsOperation } from '@/lib/account/settings.server';
import { unlinkIdentity } from '@/lib/supabase/auth';

export const runtime = 'nodejs';
export async function DELETE(request: Request, { params }: { params: Promise<{ identity_id: string }> }) {
  const { identity_id } = await params;
  return settingsOperation(request, cookies => unlinkIdentity(cookies, identity_id));
}
