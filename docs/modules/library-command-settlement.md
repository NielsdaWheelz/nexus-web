# library command settlement

status: implemented; integrated static and isolated browser qualification pass · origin: 2026-10-04 simplification · original baseline: `5e970dce0515fea7d06d8bd1af48f90d39f1c185`

## behavior

one mounted library visit admits one governance command. admission requires
confirmed capabilities/pages and an idle command slot. native capability, member
and invitation reads are separate transactions, not an atomic snapshot.
confirmation records their successful owned observation.

snapshot and authority publication preserve a sent command's slot. only its
executor releases it after local delivery completion and an authoritative reread.
refresh, paging and authority loss/restoration cannot reopen admission sooner.
restored authority still requires that executor's fresh observation. leaving the
visit suppresses late local/global effects; the server may still commit.

failed or canceled command reconciliation leaves surviving rows unconfirmed with
retry; cleared rows use the existing failed/retry surface. applied no-authority
observations remain idle and gated. cancellation proves neither rejection nor
non-commit. ordinary refresh failure preserves previously confirmed rows and
admission with a warning; unconfirmed recovery stays blocked until refresh
succeeds. a modeled unauthenticated response instead ends in the existing
authentication handoff, without an extra reread.

acknowledged/rejected/unknown feedback stays truthful. matching the requested role
in a reread does not prove this command applied it. there is no resend. releasing
the browser slot does not establish that an unacknowledged server request ceased.

search, explicit invite, server owner/default/system restrictions, cursor order,
loaded extent, recreation restart and cycle checks retain their owners. current
confirmation behavior remains; the open
[cancel-focus defect](../tickets/library-confirmation-cancel-focuses-adjacent-row.md)
is excluded.

## ownership

`useLibraryMembers.ts` owns admission through its existing command field. publication
synchronously installs the next state reference and publishes that same object to
react; rendering cannot rewind it. authority clearing preserves the slot.

one refresh function owns cancellation, observation, publication and failure
policy. ordinary refresh is coalesced/deferred during loading, reconciliation or a
running command. paging requires confirmed reconciliation, remains available during
command delivery and samples loaded extent when settlement's read begins. surface
continuation controls reflect that admission. deferring refresh can delay authority
observation. public refresh/retry facades accept no arguments; executor outcome is
private. existing mount/controller fences, native transports and cohesive
`governanceState.ts` cursor contracts remain. no new ref, phase machine, framework
or backward path is added.

## scope and qualification

physical lines: hook 870→816, unchanged state contracts 222, member surface
711→713, shared footer 31→33; all three product files total −50 authored lines,
with no generated/native change. the broad proposal was retired after #512;
this cut removes parallel read settlement without a size quota or moved-line credit.

before edits, two mounted failures at `20:51:03–20:51:05Z` and
`20:59:30–20:59:32Z` admitted a second real role patch while the first delivery or
its owned page response was held. the latter used native owner demotion/restoration
and capability reads; pane entry refresh does not reread capabilities. other red
probes reproduced stranded admission after ordinary-read supersession and page
admission during a full read, not a live cursor merge crash.

prior source `9f10d5116c7ce8290e6561ee72b8be3d37c78ab08f41ad58ca64b76bc0bc9e9c`
passes `./scripts/test` and eight real-auth/bff/api/database browser journeys
(ten checks, `21:24:57–21:29:11Z`): held commands, actual authority changes,
ordinary lost-read usability, deferred paging, preserved 105-member/103-invitation
extent, committed lost-reply feedback, command-read retry without resend and true
pane unmount with commit/no late effect.

prior facade source `d6227629176fba52b9b6f1d351f4f7d6234b014068bc45b8d1fd7a72036e52e3`
differs only by two public facades; static and focused refresh/retry checks pass on its fresh
bundle. the earlier eight retain their original provenance. canceled stale/cleared
reads and authentication handoff are source-reviewed, not live-qualified. temporary
probes are deleted after green; no production, provider or device acceptance is claimed.

delivery integrates main `58bdd8a77bb865450c8c197c4c35ca904b2ddaa5`.
governance/controller/page contracts are byte-identical to the prior qualified
source; the shared inspector now hosts a keyed dossier component. source
`66980dda4a64d9de0643910f421bfb61ea85c2ac6b1cf96fd1d0f9fa3e0f667a`
passes static and two fresh real-auth journeys through this host: held role/tab
barrier and settlement, then failed command-read/public retry without resend.
both have no page errors; the earlier eight and two facade checks remain historical.
