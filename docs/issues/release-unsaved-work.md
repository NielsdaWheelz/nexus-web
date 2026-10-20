# unsaved-work cutover

status: source implemented; production cutover pending. the
[chat qualification](unsaved-chat-live-qualification.md) owns four
owner-deferred live chat checks. the owner approved immediate discard of retired
browser state and reset of saved workspace layouts/history. deployment and production data changes require later authority.

release steps, in order:

1. qualify the implementation, then release the web and android shell together:
   root back requires both the native exit event and the web work-guard listener.
   this change adds no endpoint, wire schema or database migration. source wire 13
   already belongs to the pending release; follow the once-per-release rule if a
   release occurs before integration.
2. close old clients before reset so their last-write-wins workspace saves cannot
   restore old state. verify the approved viewer id from the release environment.
3. in one transaction, delete `workspace_sessions` rows where `user_id` equals
   the verified viewer uuid, across devices. check the affected viewer and row
   count before commit. these hold layout and workspace history; do not delete
   accepted chats, notes or other data.
4. on each used browser/webview, remove only session-storage keys beginning
   `nx_chat_draft.v7:` and local-storage keys beginning `nx_media_admission.v1:`.
   do not read/export values or clear all site storage, auth or native downloads.
5. open a clean workspace under the paired release. verify acknowledged content
   and accepted server jobs remain available, while layouts and old drafts do not
   restore. verify neither retired storage prefix nor seed-query hrefs are written.
6. separately record browser, android emulator/device and bounded production
   smoke observations. missing material qualification remains NOT_RUN.

evidence: retired keys are owned by `apps/web/src/lib/chat/drafts.ts:16,42-52`
and `apps/web/src/lib/media/admissionRecovery.ts:59,82-85`; server workspace writes
are owned by `python/nexus/services/workspace_sessions.py:36-51` at `7dc73d92d8ff`.
no data migration, export tool, compatibility reader or startup cleanup owner.

resolved when the paired release has completed these steps and its acceptance is
recorded in the implementation pr; then delete this record.
