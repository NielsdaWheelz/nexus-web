# a library refusal in the extension offers no way to choose again

status: open · origin: 2026-11-02 import build, lane s3c · area: extension / recovery

the popup words every library refusal `couldn’t import this.` / `can’t file to one of
these libraries.`, but its recovery never reopens `into`:

- at create, a deleted or non-admin library answers `E_LIBRARY_FORBIDDEN`
  (`python/nexus/services/libraries.py:529-537`), which `TERMINAL` makes `discard` only
  (`apps/web/src/extension/background.ts:61-72`): the page must be read again.
- at confirm, a library deleted after create answers `E_LIBRARY_NOT_FOUND` (404,
  `libraries.py:125`), which is not terminal, so the popup offers `retry`. retry reuses
  the frozen confirmation (`background.ts`, `submission.confirmation ??=`) with the same
  destinations and meets the same refusal every time.

only `E_RESOURCE_CONFLICT` at confirm reaches `review`, which rereads destinations,
marks the missing library `unavailable` and confirms the same staged bytes.

reproduction: choose a library in the popup's `into`, delete it in nexus, press
`import`: the popup offers only `discard`. (the lane's lab case drives exactly this.)

impact: one gone library costs the whole read; at confirm, `retry` is a dead end.

resolved when: every library refusal at confirm (`E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`,
`E_LIBRARY_FORBIDDEN`) leads to `review`, and a refusal at create lets the reader drop the
library and send again without reading the page again.
