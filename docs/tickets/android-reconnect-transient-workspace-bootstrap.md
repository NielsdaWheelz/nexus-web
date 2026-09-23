# transient workspace bootstrap failure after offline reconnect

status: open
origin: 2026-09-22, connected-device download-account repair
area: android / hosted workspace

an intermediate signed `0.2.15-compatibility-probe` (code 18, deliberately
using reader contract 1 against production contract 2) showed an unstyled
“The workspace couldn’t load” behind the expected update dialog after
downloaded reading → reconnect. cold-start → continue online worked.
screenshot: `/tmp/nexus-android-repair.KsrP7P/probe-shelf.png`, 23:18 device time.

a later probe containing the completed callback-ordering repair returned to
the styled book on the first reconnect. temporary request-denial diagnostics
showed only the departing hosted page's reader-state/telemetry requests being
blocked on entry to the shelf, not hosted assets on return. the diagnostic
and deliberately old contract are absent from the final source.

impact: the earlier failure may have an independent bootstrap cause; its
exception was not captured, so attribution to the native race is unproven.

prerequisite: reproduce on the final signed build or an equivalent controlled
compatibility probe. capture the exception logged by
`apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:71`
and failed network requests, then repair the responsible owner. do not loosen
offline network isolation based on the screenshot alone.

acceptance: identify and resolve the exception, or establish that it is
specific to the superseded intermediate build; verify the same-root
offline-to-online return with the final artifact.

the final compatible `0.2.15` / code 18 opens the existing styled reader with
no native account-attestation or runtime error in its process log. the
deliberately incompatible probe with the completed repair also passed shelf
reconnect and owned-link return; this does not establish the earlier exception's
cause.
