# the extension repeats import copy instead of importing it

status: open · origin: 2026-11-02 import build, lane s3c · area: extension / copy

`apps/web/src/extension/nexusClient.ts` (`words`) words the codes the extension's
routes answer with. six of its sentences are the web app's own import copy
(`apps/web/src/lib/imports/copy.ts`: `CAPTURE_REFUSAL`'s `E_RESOURCE_CONFLICT`,
`E_MEDIA_DELETING`, `E_INVALID_REQUEST`; `FAILURE_COPY` reasons for `E_FILE_TOO_LARGE`,
`E_INVALID_FILE_TYPE`, `E_SOURCE_INTEGRITY`), repeated as literals. importing them put
React and the imports api into the persistent background page: `background.js` went
from 28 kB to 117 kB, because `copy.ts` imports `lib/imports/api`, which imports
`lib/api/useServerList`.

impact: a rewording in `copy.ts` leaves the popup's spelling behind until someone
edits both.

resolved when: the pure tables live in a module with no React or api dependencies,
`copy.ts` and `nexusClient.ts` both import it, and `background.js` stays near 28 kB.
