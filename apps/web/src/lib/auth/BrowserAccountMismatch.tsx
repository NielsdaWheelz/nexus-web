// hosted management never borrows app credentials. a browser holding another
// account must sign in explicitly before any account controls are exposed.
import AuthSurface from '@/components/auth/AuthSurface';
import { FeedbackNotice } from '@/components/feedback/Feedback';
import ButtonLink from '@/components/ui/ButtonLink';
import { switchBrowserAccountPath, type ReturnTarget } from '@/lib/auth/urls';

export default function BrowserAccountMismatch({ target }: { target: ReturnTarget }) {
  return <AuthSurface title="sign in with the account open in the app">
    <FeedbackNotice content={{ tone: 'Danger', title: 'this browser is using a different account.', message: 'your workspace stays open in the app.' }} announcement="Polite" />
    <ButtonLink href={switchBrowserAccountPath(target)}>switch browser account</ButtonLink>
  </AuthSurface>;
}
