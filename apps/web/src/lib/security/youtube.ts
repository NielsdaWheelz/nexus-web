/**
 * Origins of the embedded YouTube player — the single source of truth for:
 * - the CSP `frame-src` allowlist (./csp.ts),
 * - the `Permissions-Policy` feature delegation (./headers.ts), and
 * - the embed component's host check (media/[id]/TranscriptPlaybackPanel.tsx).
 *
 * The iframe `allow="…"` feature list in that component must stay in lockstep with the
 * media features delegated to these origins in headers.ts. The two are deliberately NOT
 * merged (Permissions-Policy `feature=(origins)` vs iframe `allow="feature; …"` are
 * different syntaxes); keep them aligned by hand when changing the embed.
 *
 * Dependency-free (only the global `URL`), so headers.ts stays importable by next.config.ts.
 */

export const YOUTUBE_EMBED_ORIGINS = [
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
] as const;

/** Hostnames of the embed origins, for runtime URL host-allowlist checks. */
export const YOUTUBE_EMBED_HOSTS: readonly string[] = YOUTUBE_EMBED_ORIGINS.map(
  (origin) => new URL(origin).hostname,
);
