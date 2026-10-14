# session-entry coordinated release qualification

status: open
origin: 2026-10-14 session-entry implementation
area: web / android / production qualification

isolated qualification is recorded in [the plan](../session-entry-experience-plan.md).
the exact signed production apk has not been installed/qualified, and the web/api
cutover, apk publication and non-destructive production smoke have not run.
physical failure injection used a separate debug app id; it does not close these gates.

prerequisites: integrate only the feature commits onto main; use its exact first-ci
release artifacts, agree a no-use window, and follow [the runbook](../../deployment.md)
and [apk distribution rules](../../README.md#android-release-distribution).

acceptance: record deployed source identity and apk hash/version; install that exact
signed apk and prove App Links, password/provider sign-in and offline-to-online return;
publish the compatible apk with the hosted cutover; verify ordinary renewed entry,
active content and extension handoff in production without fault injection.
