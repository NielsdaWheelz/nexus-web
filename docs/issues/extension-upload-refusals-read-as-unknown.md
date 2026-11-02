# the extension reads two upload refusals as unknown

status: open · origin: 2026-11-02 import build, lane s3c · area: extension / recovery

the popup says `not sure that imported. it may have gone through.` for any 5xx to a
create or confirm (`apps/web/src/extension/background.ts`, the `Check` branch of save's
catch: `status >= 500`). two of those codes are refusals that published nothing:

- `E_SIGN_UPLOAD_FAILED` (500) at create: the session committed, presigning failed
  locally, no byte went anywhere (`python/nexus/services/media_upload_sessions.py:505-513`).
  content ruling 1 words it `couldn’t start the upload`, retry with the same id.
- `E_STORAGE_ERROR` (500) at a first confirm: raised while copying or measuring the
  staged bytes, before `publish` runs (`media_upload_sessions.py:701-714`). ruling 3
  words it `couldn’t check the file`, retry the same confirmation, unless an earlier
  confirm of the session went unanswered.

impact: the popup claims an import may have landed when it cannot have. the replay it
offers is still right, so nothing is lost; the words are false.

resolved when: the background classifies these two codes as refusals with `retry` and
the popup shows ruling 1's and ruling 3's words, keeping unknown for a confirm whose
earlier answer was lost.
