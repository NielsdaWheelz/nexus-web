# release quoted-post actions

release the changed api and web together. retain wire revision 19 from current
main; this change shares that release's existing bump. build current consumer
packages through `./scripts/test`; reject older wire.

use the normal release controller's stopped-writer migration and verified backup
preflight. the new migration converts known empty/parent-only author-thread input
to explicit nullable capture input; unknown shapes abort. standalone saved posts
and historical exact-capture receipts remain supported data.

no new production credentials or services. the existing optional `X_API_BASE_URL`
now reaches local checkout workers as well as the api; controlled qualification
uses synthetic credentials. no real-x qualification is authorized or claimed;
track that separately in `x-author-thread-live-qualification.md`.

resolved when the paired release runs the exact migration head, old wire is
refused, and quoted saving/opening works in the released reader.
