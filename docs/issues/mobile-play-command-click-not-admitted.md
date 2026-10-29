# initial browser play did not install playback

problem: in the real mobile-width chapter qualification, clicking a rendered
`Play: 690: The S in PHP is for Security` control completed without starting
playback. the player remained `nothing queued`, so chapter-menu qualification
could not reach its prerequisite. the same blocker persists with keyboard setup.

observed on pre-integration pane-opening source in lab
`20261028-191839-bc6e95958005`: the temporary chapter driver's row play `.click()`
completed, then its now-playing opener timed out. trace snapshots at
25231.073, 25265.966 and 25269.304 show the targeted button without `disabled`,
`aria-disabled` or `aria-busy` attributes. the failure screenshot shows
the row's play icon and `nothing queued`. its network trace contains bootstrap
`GET /api/me/playback-session` and the driver's descriptor read, but no
`POST /api/playback/snapshot` or playback-session write after the click.
artifacts: `.nexus-local/lab/20261028-191839-bc6e95958005/artifacts/playwright/mobile-pane-opening-chapte-e16c9-aits-for-reader-preparation/{trace.zip,test-failed-1.png}`.
integrated main run `20261028-193938-cd8e7cdec5b3` also failed after the driver
explicitly checked enabled, not `aria-disabled`, not busy, focused the button and
pressed enter. its screenshot again shows `nothing queued`. this trace includes
two successful episode descriptor reads and a playback-session read, establishing
that keyboard activation reached the player read path, but no playback-session
write followed. artifacts use the same chapter-case directory under that run.
no root cause is established; this is not explained by the opener's label.
chapter-menu qualification now uses the authenticated public playback-session
writer and ordinary reload/resume; it does not claim first-queue play success.

reproduce: acquire the real linux unplugged feed through sealed discovery and
ordinary podcast import; at 390×844 open its episode list and click episode
690's play control; repeat with its focused enter activation. inspect actual queue admission and the visible player.

resolved when both pointer and keyboard gestures start the intended episode, publish
its real playback queue/session and exposes the matching now-playing opener;
confirm against integrated main and retain chapter-menu qualification.
