# durable activity storage needs a browser check

status: open
origin: 2026-09-10 imports cutover, phase 7 chain z2; updated 2026-09-17
area: `apps/web/src/lib/consumption/`

at base `26b8161b`, the former `activityRuntime.browser.test.ts` failed 8 of 13
cases in the linux runner twice. failures included an empty durable queue after
closing an activity span and `Failed` where `Pending` or `Synced` was expected.
consumption code was unchanged since `2546a1e6` (pr #181). the cause was never
separated into a runner storage-capability problem or a product defect.

the test suite and runner are removed. rebuilding them is not an open task;
losing recorded activity in the actual browser would still be a product defect.

prerequisite: use the supported browser with an ordinary development account.
record an activity span while offline, reload, reconnect, and inspect whether
it remains durable and is delivered once. investigate the storage owner only
if this reproduces outside the removed runner.

acceptance: manual observation establishes durable storage and delivery, or a
reproduced product defect is repaired. record the browser and app revision.
