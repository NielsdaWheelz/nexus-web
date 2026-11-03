# playback refusal exposes a banned feedback word

at `3643a20b4`, `lib/player/browserEngine.ts:605` supplies `its playback
failed.` for a seek-and-play refusal while the audio element is in its failed
state. `playerRuntime.tsx:800-803` paints that message as feedback's reason.
the content contract excludes `failed`.

use `the audio couldn’t play.` at the existing browser owner. its actual audio
error event owns this state. resolved when the user-facing reason satisfies
the copy floor without changing refusal or recovery behavior.
