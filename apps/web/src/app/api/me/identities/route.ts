// reads can repeat; provider session effects belong to this response owner.
import { settingsOperation } from '@/lib/account/settings.server';
import type { SettingsIdentity } from '@/lib/account/settingsWire';
import { AuthUnavailable, listIdentities } from '@/lib/supabase/auth';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return settingsOperation(request, async cookies => {
    const result = await listIdentities(cookies);
    if (result.outcome !== 'Listed') {
      if (result.outcome === 'SessionEnded') return result;
      // this read has no successful empty fallback on provider failure.
      throw new AuthUnavailable();
    }
    const data: SettingsIdentity[] = result.identities.map(row => ({ id: row.id, provider: row.provider, email: row.email, created_at: row.createdAt }));
    return { ...result, data };
  });
}
