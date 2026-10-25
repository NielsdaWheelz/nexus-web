/** one decorative rss glyph; the added check records an observed subscription. */
export default function PodcastSubscriptionIcon({ subscribed }: { readonly subscribed: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 11a9 9 0 0 1 9 9" />
    <path d="M4 4a16 16 0 0 1 16 16" />
    <circle cx="5" cy="19" r="1" />
    {subscribed ? <path d="M22 2 16.5 7.5 14 5" /> : null}
  </svg>;
}
