# shared upload reasons overstate their causes

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; source inspection only.

problem and impact: two shared upload reasons claim history the owned result does not prove. attachments can tell a reader they lost library access while they still have read access, or attribute a session refusal to work elsewhere. these claims misdirect recovery.

evidence:

- `apps/web/src/lib/imports/copy.ts:983` maps `LibraryForbidden` to `you no longer have access to one of its libraries.`. `lib/imports/ingest.ts:58-59,64` maps the create/confirm authority codes to this outcome. the create path calls `python/nexus/services/media_upload_sessions.py:583` → `libraries.resolve_writable_destinations`; `python/nexus/services/libraries.py:535-536` raises `E_LIBRARY_FORBIDDEN` when the destinations are not writable. `libraries.py:545-548` requires an admin membership and excludes default/system libraries. a reader membership can remain; this does not prove lost read access or any past change.
- `apps/web/src/lib/imports/copy.ts:1028` maps `Superseded` to `this upload changed elsewhere.`. `lib/imports/ingest.ts:65-66` maps both `E_UPLOAD_SESSION_NOT_FOUND` and `E_UPLOAD_GENERATION_STALE` to it. `python/nexus/services/media_upload_sessions.py:1063-1072` masks absent session, wrong owner and wrong origin alike as not found. `:1076-1079` proves only generation inequality. neither producer proves another device or place caused a change.
- `apps/web/src/components/connections/useConnectionAttachments.tsx:108` consumes the shared message beneath its file fact. no local override is needed.

smallest proposed correction: change the one shared `LibraryForbidden` reason to `you can’t add to one of these libraries.` and the one shared `Superseded` reason to `this upload can’t continue.`. keep current outcome classification, exact retry identity and publication fences unchanged. both fit the fourteen-word composed floor with the longest existing four-word upload fact.

resolved when: each shared consumer uses those cause-bounded reasons (or an equally proven sentence); an unreadable destination is not described as lost access, and session absence/generation mismatch never claims work elsewhere. preserve the existing terminal fence semantics. a different writer implements; root owns the repository record and assignment.
