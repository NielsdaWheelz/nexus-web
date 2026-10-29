# release contents and extracted works

the contents read and preview responses change shape, the standalone navigation
route is removed, and candidate decisions require a nullable reviewed-navigation
key. pair the api, web and packaged clients at release; old clients must fail at
the existing wire gate, not receive compatibility responses.

this branch inherits wire 17 from `636d3603e`. the last reported deployed source
`3d81ef45e` uses wire 16. reuse the existing unshipped bump; release preflight must
recheck actual deployed source and revision before choosing a number. no settings,
accounts or deployment are changed by this implementation.

no database migration or backfill is required. existing source text, work ids,
boundaries, decisions and original creation bindings retain their meaning.

resolved when the paired release serves the new contents/preview contracts,
rejects obsolete wire clients, and confirms extraction/open, proposal acceptance
and restoration against the released build. implementation qualification alone
does not close this release step.
