# navbar launcher verification

status: qualified; temporary tests and credentials deleted.
origin: 2026-10-14 implementation; branch `codex/navbar-launcher-20261014`.
source: `367da80e0c1beb1c426f6d2d72201b0733809b50` plus the four product-file
changes recorded in the receipt's dirty state and `source-hashes.json`.

story: the rail's native search action opens the existing nexus root and focuses
its real query. collapsed help remains passive, hoverable and dismissible.

## environment and evidence

task-owned worktree: `/Users/nnandal/Documents/code/nexus-web-navbar-launcher-20261014`.
real next app `http://localhost:27724` → fastapi `127.0.0.1:28121` → standalone
postgres `28101`, with local supabase auth `28111`. the fresh disposable account
signed in through the actual password form. no mocked client, api or data path.

evidence root: `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-14/navbar-implementation/`.
browser: chromium `147.0.7727.15`; desktop `1280×900`, short desktop
`1280×440`, breakpoint `769→768→769`, mac/windows user agents and desktop touch.

| run | observed result |
|---|---|
| `evidence/red-2026-10-15T06-46-06.990Z/receipt.json` | native activation/focus, touch and above/below menus green; old copy, missing launcher help, destination hover transfer and focused escape independently red |
| `evidence/green-1-2026-10-15T06-50-07.235Z/receipt.json` | 12/14; two driver races exposed: hovering before hydration and asserting immediately after css breakpoint hiding |
| `evidence/green-2-2026-10-15T06-52-37.735Z/receipt.json` | 15/15 at `2026-10-15 06:52:38–06:52:56 utc`; explicit client-readiness and eventual unmount assertions; zero page errors |
| `evidence/transition-final-2026-10-15T07-06-20.491Z/receipt.json` | native pointer transfer during collapse enters the host with zero gap; caption remains visible at entry, next frame and text entry; zero page errors |
| `static-final.log` | complete `./scripts/test` passes, exit 0 |

green cases cover click/enter/space once, actual query focus, empty escape and
return focus; exact label and shortcut; collapsed hover/focus; shared destination
repair; independent hover/focus persistence; full-edge corridor and bubble
transfer; activation/description cleanup; passive command/control+k; modified
and composing escape; scroll/clipping; collapse movement; three themes; windows
hint fit; breakpoint restoration; desktop touch; existing above/below menus.

the rAF trace recorded transient gaps up to 21px. four actual pointer transfers
entered an attached host; their path later overshot the moving caption. the
final bounded probe stops at entry: at 124ms, anchor width was 99.52px and
anchor right equalled host left at 107.52px. help stayed visible through text
entry. the sampled trace did not demonstrate a broken hover path; no additional
source repair was justified. the pre-publication product files match the green
run's recorded hashes.

publication: the clean rebase onto `7bc7c8a13` preserves three upstream workspace
field renames in `AppNav`. the tooltip hook, css and positioning files are
unchanged. the feature patch is identical under `git range-diff`; post-rebase
static qualification runs in [pr #625](https://github.com/NielsdaWheelz/nexus-web/pull/625).

## review and limits

independent design and architecture cross-reviews found no steady-state
contract gap. the integration review added an explicit typed hook interface and
live-anchor observation in the existing positioning observer. no overlay-kernel,
command-center, shortcut, backend or schema changes.

visual review: resting search reads as a peer navbar action; focus uses the
existing ring. light/dark/elvish captures show legible captions, aligned labels,
nonshrinking 20px icons and intact targets without overflow or overlap.

the driver executes no content command, result or workspace action. the app
bootstrapped its default library and persisted `PUT /api/me/workspace-session`
in its isolated account.
existing user data was untouched. composition uses a browser `KeyboardEvent`;
physical ime and screen-reader behavior were not exercised. chromium only;
windows platform and touch capability were simulated, not physical devices.

the first `./scripts/test` attempt passed backend checks, then stopped because
the new worktree lacked its ingest dependency link. that setup was repaired;
the complete gate passed (`static-final.log`, exit 0), including eslint,
typescript and migration head `0278`. known custom-highlight minifier warnings are
tracked in [the existing ticket](tickets/offline-css-minifier-rejects-highlight-syntax.md).
the existing [add-panel alignment warning](tickets/add-panel-css-build-warning.md)
also recurred in the development server.
the unrelated local bucket-initializer image refusal remains in
[its ticket](tickets/local-minio-init-image-unavailable.md).

the follow-up probe paused during the shared docker/disk recovery; sign-in had
returned 503/connection reset. after the owner's all-clear, only task-owned app
services resumed. real login and data reads succeeded; the bounded probe passed.
the navbar task issued no engine restart, prune, reset or production operation.

cleanup: disposable drivers, provisioner, credentials, exported auth/config and
runtime identity were deleted. browsers, app/api processes and six task
containers are stopped. per the owner's recovery instruction, all three named
data volumes and two bind-mounted auth templates remain intact. receipts:
`evidence/verification-cleanup.json`, `evidence/environment-cleanup.json`.
no dependency installation, test framework, production seam or permanent suite
was added. existing locked development dependencies were reused.

the three scoped defects are closed. query-arrow editing, the existing build
warnings and the bucket-initializer image refusal remain separately tracked.
