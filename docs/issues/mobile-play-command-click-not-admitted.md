# mobile play click did not admit playback

problem: in the real mobile-width chapter qualification, clicking a rendered
`Play: 690: The S in PHP is for Security` control completed without starting
playback. the player remained `nothing queued`, so chapter-menu qualification
could not reach its prerequisite. keyboard setup is being qualified separately.

observed on pre-integration pane-opening source in lab
`20261028-191839-bc6e95958005`: the temporary chapter driver's row play `.click()`
completed, then its now-playing opener timed out. trace snapshots at
25231.073, 25265.966 and 25269.304 show the targeted button without `disabled`,
`aria-disabled` or `aria-busy` attributes. the failure screenshot shows
the row's play icon and `nothing queued`. its network trace contains bootstrap
`GET /api/me/playback-session` and the driver's descriptor read, but no
`POST /api/playback/snapshot` or playback-session write after the click.
artifacts: `.nexus-local/lab/20261028-191839-bc6e95958005/artifacts/playwright/mobile-pane-opening-chapte-e16c9-aits-for-reader-preparation/{trace.zip,test-failed-1.png}`.
no root cause is established.

reproduce: acquire the real linux unplugged feed through sealed discovery and
ordinary podcast import; at 390×844 open its episode list and click episode
690's play control. inspect actual queue admission and the visible player.

resolved when the same pointer gesture starts the intended episode, publishes
its real playback queue/session and exposes the matching now-playing opener;
confirm against integrated main and retain chapter-menu qualification.
