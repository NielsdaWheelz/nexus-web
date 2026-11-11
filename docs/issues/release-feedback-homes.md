# feedback release observations remain unqualified

the feedback implementation is merged. this record retains paired-client
observations; it is not an instruction to redeploy the historical wire 18 cut.
current contracts live in [feedback](../modules/nexus-command-feedback.md),
[overlays](../modules/overlays.md) and [deployment](../../deployment.md).

owner disposition, 2026-11-04, recorded in commit `88e92445b`
([pr 901](https://github.com/NielsdaWheelz/nexus-web/pull/901)):
for `c6c90343c4324942b310fe7d9b9fadc4f6e5e944`, the owner waived phone
sign-in, persistent signed firefox update/capture and offline-to-online
reconnect qualification before publication. signing or an in-place apk upgrade
does not establish those observations. the waiver was for that release only.

remaining checks on identified paired artifacts: unavailable-session playback
resumes from its descriptor; refused and unknown saves stay distinct; sign-in
shows pending state; account/stopped-store feedback is accurate; copy recovery
preserves uncommitted text; and phone feedback clears fixed controls and keyboard.
physical safe areas and actual assistive speech require their own observations.
[import acquisition](release-import-acquisition.md) retains its separate checks.

future publication must use the current release vector and deployment owner,
pair hosted/android/extension assets, and retire the previous authored worker
without discarding local commands. old code-only rollback instructions do not
apply across later durable-format changes.

close when the outstanding observations are recorded at their actual scope
or explicitly dispositioned by the owner. source qualification is not device proof.
