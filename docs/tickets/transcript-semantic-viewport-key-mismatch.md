# transcript semantic viewport key mismatch

status: deferred · origin: 2026-10-04 independent source review · area: reader / activity

the transcript viewport publisher and semantic acceptance reader disagree on source identity. the publisher uses one transcript segment while the accepted key includes an additional transcript content-generation segment. acceptance returns null, leaving transcript reading activity ineligible. the durable cursor path is separate.

source-only evidence at `557aed14f1d88bdb2b1bc9856944ce433e38f115`: `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2549` publishes `${id}:transcript:${fragmentId}`; `:1592` constructs `${id}:transcript:transcript:${fragmentId}` and `:1729` requires equality. `ReaderActivityAdapter.ts:128` requires a non-null eligible viewport. no mounted activity loss or durable-cursor failure is claimed. prerequisite: publisher and acceptance share the same source/content-generation identity contract. repair the media pane/activity owner separately from notes.

resolved when: actual mounted transcript reading produces accepted semantic viewports and eligible activity after genuine input; quiet inspection stays ineligible, and durable cursor behavior remains intact.
