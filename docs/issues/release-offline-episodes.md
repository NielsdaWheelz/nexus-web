# downloaded episodes release

pair backend, packaged interface and apk. wire revision 15 already covers the
unreleased cutover; do not advance it again before that release. migration
`0315_consumption_observation` follows `0314` and initializes the account observation
watermark to 1 without changing progress, overrides or membership. rehearse it on
the newest production backup before merge. catalog format 2 requires a successful
online rebuild before claiming the new offline projection contract.

hard-cut both old native bridge names and audio-only readiness. convert released native
state explicitly and durably before normal new-format operation: preserve reading
copies, their pending positions, account binding, queue and listening facts. old
audio-only rows become actionable `NeedsDownload`, never ready playback packages;
retain their bytes until explicit retry/remove. retry acquires a new rendition,
not new metadata blessed onto old audio. remove the format-1 compatibility arm and
all old operational readers; conversion is a data migration, not an alternate
playback path. offline state converts released format 2 to format 3; the released
unversioned playback envelope converts to format 1. assign local fact sequences in
saved lane order without changing request bodies/reset fences. preserve local
resume/settings, queue and checkpoint; set canonical observation null until a real
new server response supplies it. old descriptor content grants no new package
readiness. each envelope converts durably before its owner starts; restart completes
any unconverted envelope. migration needs no network. refuse malformed/unconvertible
state without deleting it.

before the paired cutover, pause and sync old pending reading/listening work where
possible; retain a verified recovery copy. inability to preserve an unsent fact is
a release blocker, never permission to discard it. document the exact conversion
inputs/data effects and prove old bytes, queue, reader and listening facts are
preserved as specified. obtain owner approval before any destructive repair.

qualify emulator and physical-phone cold restore, never-queued download playback,
background/lock-screen continuation, explicit user-stop recovery, source refusal,
storage failure and account retirement with the paired build. use an isolated qa
application id before touching the installed personal app. resolve the recorded
native-player initial connection failure or establish it cannot occur on the shipped
path with concrete evidence. retain no silent reload workaround.

resolved when conversion, paired installation and the required device journeys are
observed; put proof and remaining device/release limitations in the implementation pr.
