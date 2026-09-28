# the web still decodes the retired failed_quota transcript state

status: open · origin: 2026-09-27 cleanup pr-03 (delete billing) · area: podcasts / transcript web

migration 0252 rewrites every `media_transcript_states.transcript_state =
'failed_quota'` row to `failed_provider` and narrows
`ck_media_transcript_states_state`, and the backend no longer emits
`failed_quota` or the action state `FailedQuota`. pr-03 kept both literals on
the belief that the web deploys before the backend. it does not: merging
deploys nothing, and `deploy/hetzner/deploy.sh` releases web and backend at one
sha (`deployment.md`), so no deployed web meets a backend that emits them. the
literals remain in strict `expectOneOf` decoders and one label:

- `apps/web/src/lib/media/transcriptView.ts:13` (`TRANSCRIPT_STATES`)
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/episodeTranscript.ts:166`
- `apps/web/src/lib/actions/resourceActionSnapshot.ts:144,411`
- `apps/web/src/lib/actions/resourceActions.ts:128` (`FailedQuota: "Retry transcript"`)
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx:215`
  (requestable-branch condition; it has no copy of its own)

prerequisite: none.

fix: delete the literal from every site above.

acceptance: `rg 'failed_quota|FailedQuota' apps/web` prints nothing, and
`./scripts/test` passes.
