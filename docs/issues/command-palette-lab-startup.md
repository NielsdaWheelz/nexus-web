# intermittent browser store startup during palette qualification

open; cause not established. chromium on the disposable palette campaign
`96dbb6155` sometimes renders `couldn’t open your notes on this device` before
the launcher mounts; later cases in the same run succeed. affected journeys
cannot count as palette passes. firefox storage journeys opened successfully.

observed in private run `20261028-182225-163c67b93d59`, including named-import,
arrows-space and root-escape cases. public failure boundary:
`apps/web/src/lib/authored/provider.tsx:84`; store opening begins at
`apps/web/src/lib/authored/client.ts`. the lab uses its existing persistent
profile and scoped durable-storage grant. inspect the public details message
and underlying failure before assigning a cause; no retry is resolution.

resolved when the cause is identified and corrected at its owner, and the
previously failing fresh-profile journeys pass with their required storage
permission and startup checks. retain a separate browser qualification limit
if the environment cannot exercise those journeys.
