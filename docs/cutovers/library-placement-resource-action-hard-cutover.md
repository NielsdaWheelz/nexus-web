# Library Placement Resource Action — Supersession Record

**Status:** SUPERSEDED · 2026-08-05

This document has no remaining normative clauses. The complete placement and
surface contract is owned by
[Exhaustive Canonical Resource Actions Hard Cutover](canonical-resource-action-menu-hard-cutover.md).
Chooser interaction is owned by
[Library Chooser Interaction Hard Cutover](library-chooser-interaction-hard-cutover.md),
and the current domain contract is documented in
[Libraries](../modules/library.md).

The durable product boundary remains:

- `Share…` owns links and access; `Libraries…` owns resource organization.
- `RelationshipAction.LibraryPlacement` is one canonical, ubiquitous Media or
  Podcast action. Location and viewport never change its membership or order.
- The self-loading placement editor exposes Saved in Nexus for Media and every
  visible named Library, including inherited, system-managed, and blocked
  states with typed provenance/reasons. It supports search and Create Library.
- `library_entries.py` remains the sole relationship writer. Every mutation
  reauthorizes in its owning transaction and is followed by canonical action
  snapshot reconciliation and an authoritative placement read.
- Podcast placement never creates a subscription. `All` presence is the active
  subscription; named placement requires that subscription and uses the
  idempotent Podcast placement commands.
- There is no Share-owned placement UI, legacy flat-Boolean relationship
  contract, surface-specific menu builder, compatibility path, or fallback.

Current authenticated routes:

```text
GET    /media/{mediaId}/libraries
POST   /media/{mediaId}/libraries
PUT    /media/{mediaId}/saved-in-nexus
DELETE /media/{mediaId}/saved-in-nexus
DELETE /media/{mediaId}/libraries/{libraryId}

GET    /podcasts/{podcastId}/libraries
PUT    /libraries/{libraryId}/podcasts/{podcastId}
DELETE /libraries/{libraryId}/podcasts/{podcastId}
```

The list response is the closed
`destination × relation × availability` union defined by the canonical
cutover. Media add is a bodyless idempotent command; Media removals and Podcast
add/removals return typed collection revisions. Podcast writes require one
stable `Idempotency-Key` across replay.
