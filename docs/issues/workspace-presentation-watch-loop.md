# workspace presentation reads recreate unavailable watches

at `3942b8fd2`, the title-only recovery case in private run
`20261021-124029-3695898bc692` records 674 workspace-presentation reads and 673
version probes with the same pending page ref between monotonic 39160 and 49895.
the presentation remains null and its version state remains unavailable.

`apps/web/src/lib/workspace/presentations.tsx` rebuilt every watch whenever a
reply replaced `read.facts`. each fresh unavailable watch invalidated titles and
started the next read, losing the receive owner's unavailable-state deduplication.
this floods reads and renders while a retained unpublished or unavailable page
exists.

the owner now reconciles watches by account and ref, retaining existing handles
across title replies and stopping only removed refs or the account lifetime.
source repair is unqualified. resolved when the retained pending/deleted-ref
journeys stop issuing repeated unchanged probes/title reads, and later real title
publication or canonical deletion still updates their watched presentation.
