# desktop player host qualification

remaining manual checks:

- resume a hidden desktop player with an actual browser hardware media key;
  verify reveal without focus movement. browser space-key resume and the shared
  public resume admission are qualified; the os media-key dispatch was not run.
- use an actual screen reader to inspect empty/loading/error states, the rail's
  playback/failure description, and hidden-player announcements. browser
  accessibility semantics and keyboard focus were checked; an assistive
  technology session was not run.

native read/page fault ordering remains separately tracked in
[native queue qualification](native-queue-refresh-accepts-retired-engine-results.md).

resolve when the two real-host checks pass and the native record receives its
own qualification or explicit owner disposition. no wire/schema change is needed.
