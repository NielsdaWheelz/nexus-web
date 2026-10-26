# global and scoped authored search parity

owned scoped rows previously disappeared because the ui suppressed their server
projections without a complete local scope owner. `b741b749a` implements bounded
separate scope inputs; `81bf46590` retains independently authorized peer-highlight
endpoint membership; `bf2a168d7` chooses the requested reading before matching
and confines exact-reference resolution to that result.

`cb15a9cd4`, run `20261026-120506-2f1b73aa432e`, passes all ten browser journeys:
media/library live-link overlays, conversation facts without note traversal,
normalized part quotes across chunks, peer membership without peer ownership,
family/scope filters before paging, exact saved references, and clipped highlight
context. overlapping-part ranking counts body extent, not required-note bytes;
canonical captures remain unchanged. the offline driver’s worker-start handshake
was corrected after a causal debugger-wait diagnosis; application startup did
not change.

installed run `20261026-133515-3eb59e903795` on `eb5c9ebf6` exposes a remaining
global-search defect: canonical all/library search clips a highlight's suffix to
the authorized part, but local `all` returns the out-of-part match. the shared
`searchQuery` early return bypasses reading ownership and clipping. scope facts
also conflate workspace membership with independently readable retained media.
repair both highlights and media passages through the same admitted-owner rule.
ordinary note/page search must remain available while source inputs hydrate.

search activation also loses the selected part: `localResourceHref` opens the
immutable capture's original source. carry the query's selected reading as result
metadata; preserve canonical capture and exact highlight/passage arrival.

separate real-server owner checks pass part-only authorization, required notes,
bounded paging, publication/part revision changes, revocation and same-digest
readmission. the 128 mib case returns 314 responses, maximum 462,047 bytes and
0.929 s. this proves bounded server delivery, not installed-device performance.

remaining: qualify the installed android search ui against these same laws, with
actual multi-document hydration/recreation, explicit revocation, complete atomic
readmission and offline cold reopen. use the production shared scoped executor;
the isolated native-capacity helper’s raw `compileQuery(search)` is all-scope
only and cannot serve as a scoped oracle. keep authored writing available while
scope inputs hydrate. the separate normalization race record owns its stale-page
and publication obligations. resolve after installed-host evidence; do not infer
it from browser or backend greens.
