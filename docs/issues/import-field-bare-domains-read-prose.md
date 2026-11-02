# the import field reads file names and dotted words as links

status: open · origin: 2026-11-02 import build, lane s2a review · area: imports / parser

the spec gives the import field, and only it, bare domains: `extractLinks(text,
"UrlsAndDomains")` reads any `label.letters` token as `https://` plus the token
(`apps/web/src/lib/extractLinks.ts:25-26`, `BARE_DOMAIN` at `:41`: any 2 to 63
letter tld). syntax cannot tell `README.md` (`.md` is moldova's), `Node.js`,
`asp.net` or `chapter.one` from a domain the reader meant.

reproduction: paste `see README.md and Node.js, then https://a.com` into the
import field and press ⏎. three links go out (`https://README.md`,
`https://Node.js`, `https://a.com`), with no review (spec trade-off 1).

impact: each false link becomes an import that fails, or one of a stranger's
host, fetched by nexus. the sieve row exists for mixed prose, which is where
these tokens live.

resolved when: the owner rules what counts as a bare domain (say, a known tld
list, a lowercase host, or a token alone in the field) and `UrlsAndDomains`
meets that rule, or the owner accepts these reads as a trade-off.
