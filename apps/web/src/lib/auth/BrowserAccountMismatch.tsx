// hosted management never borrows app credentials. a browser holding another
// account must sign in explicitly before any account controls are exposed.
import AuthSurface from '@/components/auth/AuthSurface';
import { Fact } from '@/components/feedback/Fact';
import { switchBrowserAccountPath, type ReturnTarget } from '@/lib/auth/urls';

export default function BrowserAccountMismatch({ target }: { target: ReturnTarget }) {
  return <AuthSurface title="sign in with the account open in the app">
    <Fact line={{ fact: 'this browser is signed in to a different account.', reason: 'your workspace stays open in the app.' }}
      verbs={[{ label: 'switch account', href: switchBrowserAccountPath(target) }]} speak />
  </AuthSurface>;
}
