# intermittent firefox lab launch timeout

canonical headless firefox sometimes times out after 180 seconds in
`openLabBrowser`, before the journey starts. this interrupts required browser
qualification and requires repeating the affected journey.

at `cd7d935bbf85cb92151e6f83d35f1f594e787c17`,
`apps/web/scripts/lab/browser.ts:56` failed before routes or navigation in:

- l2b declaration 5, run `20261103-114232-05b9e13e868c`.
- p2-stage declaration 5, run `20261103-140011-0a2df0cddc80`.
- settings declaration 3, peer launch, run `20261103-141439-be691b651e10`.

chromium completed these journeys. the distinct firefox pids and private profiles
were verified absent after cleanup. the launch logs contain a framebuffer warning;
neither that warning nor the shared failed boundary proves a common cause.

resolve this at the browser/dependency/environment startup owner using the retained
launch traces. establish the cause, verify its repair and cleanup, and execute the
affected firefox journeys through their unchanged assertions. a passing repeat
qualifies that journey; it does not itself resolve the recurring launch failure.
