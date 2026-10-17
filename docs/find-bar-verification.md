# pane find verification

date: 2026-10-16. status: complete within the owner-approved exceptions and
recorded limits; verification resources deleted; final static check passed.

## identity and environment

- baseline: `69c00182c8328f46cec893517971f87f03cdbf16`.
- implementation: `d03fc1ff399fcfcd82f66b95401078e64f3792da`;
  application source tree `5990d17063105ddd9f2abeb984b850d2342d81fb`.
- branch/worktree: `codex/find-bar-20261016`, `nexus-web-find-bar-20261016`.
- frozen next build: `h7nleX3yGhtePc0pd9IJQ`, next 15.5.22. web and api
  `/version` report the implementation sha; api `/readyz` reports ready at
  schema `0286`. no deployment.
- isolated mac stack: web `3417`, api `18417`, postgres `61120`, auth `61121`,
  minio `19117`. real password sign-in and browser → bff → api → database.
  disposable playwright 1.59.1; chromium 147.0.7727.15 and webkit 26.4.

the database is a copy of an existing isolated snapshot, migrated `0277`→`0286`.
vector embeddings were omitted; one copied pending metadata job was retired
before migration. no worker or external model provider ran. the copied book's
image assets were not restored; its checks cover canonical text and scope.
the two pdf originals were fetched from their public sources, matched against
the stored sha256, and restored into the isolated bucket. no responses, search
results, auth checks or production code were substituted.

## observed outcomes

| gate | result |
| --- | --- |
| baseline | three genuine reds: idle instruction visible; return strands a changed query in searching; return drops focus to body |
| frozen build | all 14 ordinary live cases passed in 34.2 seconds |
| standalone entrypoint | idle, return race and real pdf smoke passed; client assets loaded |
| second engine | three webkit idle/focus/320px checks passed on the same application source |
| phone | sm_s906w, chrome 155.0.8059.79: ordinary portrait sign-in, find, return, native back, options, whole word and close passed |
| static/refactor | `./scripts/test` passed after refactor and again after deletion, exit 0 |
| review | three source reviewers; rendered-content review; independent cleanup audit; no code blockers |

the 14 cases cover idle/clear footprint; real next/previous/wrap and results
preview; case/whole-word/chip recovery; rapid edits and clear; return during
debounce, explicit next and fresh-edit navigation; author draft retention;
collection count/reset; 320px and enlarged text; pdf supersession with unchanged
saved reader state; scanned-pdf failure/bar retry; unavailable captured scope
and companion retry/recovery; pane owner replacement/back with a fresh session.

the race uses browser clock control installed before navigation, real input and
return handlers, and two queries with different result counts. a real wheel
gesture establishes reading intent. assertions poll native smooth-scroll
completion: advancing javascript timers alone does not finish that animation.
the native clock resumes before checking for a late jump. no private hook state
or invented asynchronous provider is used.

fixtures from the isolated copy:

| fixture | id / reproduction |
| --- | --- |
| conversation | `63bbb466-ca09-4f57-8692-b15db852c616`; `montaigne` finds two, `submission` three; edit then return before debounce settles |
| text | `e6b755eb-c744-4391-b6ec-2b3ed2553837`; `the` overflows; `commiseration` finds one; narrowing the initially unavailable section refuses broadening |
| pdf | `efac829b-c4de-4ab9-a46f-c588017183d4`; `learning`, rapid replacement and clear; reader-state equality before/after |
| scanned pdf | `a0f8e56d-6f15-48e1-8b96-c5e3503de5d7`; `growth` produces the real no-searchable-text refusal; retry preserves focus |

## limits and cleanup

the owner waived accessibility-specific testing. a real partial transcript was
unavailable; the owner authorized skipping that live case and
[tracking the gap](tickets/find-partial-transcript-live-verification.md).
same-publication wrapper churn and lifetime retirement were additionally source
reviewed. qualification applies to the exact source/build above; later peer
changes and current main were not composed or qualified here.

the phone used a separate incognito context with touch enabled. chrome had to
be brought to the foreground before its target was brought forward and navigated.
earlier background-browser attempts were inconclusive; no forced pointer result
counts as a pass. return left the input focused with the real keyboard open;
native back hid the keyboard, then ordinary taps exercised options and close.
the inherited landscape/keyboard combination let pinned chrome overlap find
controls; portrait passed. this [open layout limit](tickets/phone-landscape-keyboard-overlaps-pane-controls.md)
is not a claimed pass; its root cause and baseline reproduction remain unproved.

all page targets present at each context's entry survived its closure. the two
historical ids supplied by the previous owner were already absent before our
first context; that limits the preservation witness and does not establish
user-state loss. original app foreground, rotation settings `0/1`, baseline
forwards `52905/52319` and reverse `3296` were restored/rechecked. only our dynamic
forward and reverse `3417` were removed. no apk installation, default-tab
navigation or adb-server restart occurred. release was acknowledged before the
next owner's explicit start; find made no further phone calls.

review also recorded the existing
[failed result activation focus gap](tickets/find-result-activation-failure-drops-focus.md)
and [unsupported package start command](tickets/web-start-script-disagrees-with-standalone-build.md).
the latter prompted use of the generated standalone server with copied assets.
the final static gate also emitted the already recorded
[custom-highlight minifier warnings](tickets/offline-css-minifier-rejects-highlight-syntax.md).

temporary cases, driver dependencies, credentials, copied data and owned local
services were removed: the exact task directory, web/api listeners, isolated
supabase project with its volumes, and task postgres/minio containers with their
volumes. existing check infrastructure, other worktrees and other service
resources were preserved. regular product dependencies/build artifacts and
shared browser caches/images remain.
an independent read-only audit confirmed that the task listeners, six containers,
three data volumes, project network and temporary directory were absent, with
no test-only dependencies or manifest/lock changes in the worktree.
deleting the cases removes future automatic regression coverage; this record
retains the behavior and reproduction evidence.
