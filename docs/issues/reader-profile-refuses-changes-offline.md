# reader profile refuses changes offline

problem: the installed app's refusal of reader-profile changes without remote
admission is verified by code reading only. `ReaderProvider` publishes `editable`
(`apps/web/src/lib/reader/ReaderContext.tsx:57`); `intend` refuses every change
without admission with a fresh Neutral attention notice, "changing reader
settings requires a connection" (`:105-119`), withdrawn when admission returns
(`:129-133`). the media view menu's theme row disables with "requires a
connection" (`app/(authenticated)/media/[id]/chrome.tsx:92-93`); a focus-mode
chord reaches the same refusal (`:193,200`); the settings form shows the reason
and disables its fieldset
(`app/(authenticated)/settings/reader/SettingsReaderPaneBody.tsx:36-39`). the
contract is `docs/modules/reader-implementation.md:199-205`. the plain web never
reaches this path: admission is always ready there (`lib/native/admission.ts:6`).

impact: a native defect here would bring back silent no-ops offline. offline you
still cannot darken the reader, while rooms (a cookie) change offline.

decided (owner, 2026-10-25): refuse visibly; never write on reconnect
(`lib/native/admission.ts:2`, "Ready transitions wake reads, never writes").

resolved when, on a handset with admission not ready, the menu row and the settings
form are disabled with the reason, and a focus-mode chord shows the refusal notice.
