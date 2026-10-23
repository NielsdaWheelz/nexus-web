// hosted identity linking: app account expectation crosses every provider
// roundtrip; the browser supplies its own session and pkce verifier.
import { cookies } from 'next/headers';
import AuthSurface from '@/components/auth/AuthSurface';
import ButtonLink from '@/components/ui/ButtonLink';
import BrowserAccountMismatch from '@/lib/auth/BrowserAccountMismatch';
import { verifySession } from '@/lib/auth/session';
import { expectedAccountPath, firstParam, OAUTH_PROVIDERS, oauthPath, parseReturnTarget, PROVIDER_NAMES } from '@/lib/auth/urls';
import { listIdentities } from '@/lib/supabase/auth';

export default async function AccountIdentitiesPage({ searchParams }: {
  searchParams: Promise<{ expected_account_id?: string | string[] }>;
}) {
  const viewer = await verifySession();
  const expected = firstParam((await searchParams).expected_account_id);
  const target = parseReturnTarget(expectedAccountPath('/account/identities', expected));
  if (expected !== null && viewer.userId !== expected) return <BrowserAccountMismatch target={target} />;
  const result = await listIdentities((await cookies()).getAll());
  if (result.outcome !== 'Listed') throw new Error('Identity lookup failed');
  return <AuthSurface title="linked accounts" description="choose an account to link to the account open in the app.">
    {OAUTH_PROVIDERS.map(provider => <ButtonLink key={provider} href={expectedAccountPath(oauthPath(provider, 'link'), expected)}>
        {result.identities.some(identity => identity.provider === provider) ? `link another ${PROVIDER_NAMES[provider]} account` : `link ${PROVIDER_NAMES[provider]}`}
    </ButtonLink>)}
    <a href={target}>refresh linked accounts</a>
  </AuthSurface>;
}
