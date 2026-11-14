# search scope word shows a ref

problem: the search collation scope word reads its raw ref instead of its title.

impact: a scope supplied by an in:<ref> operator or scope= url is hard to identify.

evidence: apps/web/src/app/(authenticated)/search/SearchControls.tsx publishes query.scope as the chosen scope option label. the collation removes the chip but does not resolve the ref.

resolved when the scope word shows the resource title through the existing resource-item reader, and a scoped search journey verifies the displayed title and unchanged scope identity.
