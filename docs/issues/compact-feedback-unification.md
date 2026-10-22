# make feedback compact, contextual, and consistent

status: specified; design approved, application implementation not started
origin: 2026-10-16 feedback audit and owner direction; source at `69c00182c832`
area: web / shared feedback and status presentation

problem: feedback spends too much space and attention on routine facts, while
several surfaces bypass the shared presentation. the owner requests effortless
at-a-glance understanding, immediate common actions, and optional expansion.

implementation contract: compact feedback plan (#650). the plan
owns final api, content, file boundaries and verification; the outline below
records the finding and design direction.

evidence:

- `apps/web/src/components/feedback/Feedback.tsx:383-408` repeats tone as icon
  and literal label, then renders equally styled actions below the message.
- `Feedback.module.css:50-108` adds a colored edge, a 3rem tone column and
  card padding; `:26-38,253-256` permits a persistent rail up to 48% of desktop
  height or 42% of mobile height.
- `apps/web/src/lib/media/mediaErrorMessage.ts:39-68` describes normal
  preparation as a warning; the media pane builds separate banners at
  `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:378-412`.
  local document find searches publication text independently
  (`apps/web/src/lib/documentReader/text/find.ts:60-75`), so copy must identify
  the particular unavailable search/ai capability.
- `apps/web/src/lib/documentReader/DocumentReader.tsx:265-375` combines reader
  navigation, sync and conflict controls in a separate wrapping status strip.
- `apps/web/src/components/workspace/PaneRouteErrorBoundary.tsx:68-102` owns
  another failure presentation. imports already have shared recovery and
  retained task history (`docs/modules/imports.md`); preserve those owners.

prerequisites: retain the current command identities, readiness distinctions,
pane containment, theme tokens, mobile surface geometry and accessibility
contracts. repair the separately recorded [uncertain admission lifetime](unresolved-admission-recovery-expires-with-hud.md),
[index observation](media-ready-reader-does-not-observe-indexing.md), and
[invisible position failure](reader-progress-load-failure-is-invisible.md).
existing retry focus (`retry-notice-drops-focus`, closed by #650),
pane defect classification (`pane-boundary-retries-internal-defects`, closed by #650), and
invalid link retries (`link-composer-offers-retry-for-non-retryable-failures`, closed by #650)
remain relevant; this ticket does not replace them.

proposed fix:

- evolve the existing feedback module: one short sentence, a direct useful
  action, optional explanation and secondary choices. remove visible tone
  names and redundant decoration; keep meaning understandable without color.
- two presentation scopes: local to the affected field/row/pane, and workspace
  for shared conditions or work that outlives its initiating view. use existing
  pane chrome where necessary; add no competing event bus or permanent row.
- share message/action/disclosure styling across quiet status, actionable
  notice, transient receipt, and full-surface state. state and recovery stay
  with their domain owners. standalone reader/extension renderers require no
  hosted workspace provider.
- integrate held-position navigation into reader controls. use precise
  capability status near affected commands. keep routine success quiet and
  imports/history in imports; retain its attention-count meaning.
- replace growing workspace cards with a compact current-condition summary
  and explicit expansion. show the highest-consequence issue and remaining
  count; keep the order stable during interaction. do not add an inbox of old
  receipts or conflate hiding with resolving work.
- no hover-only recovery, timing-only recovery, invented progress percentages,
  universal retry, or generic cancel. pending actions retain focus and position;
  expansion reveals information without moving the primary control.
- update `docs/modules/visual-system.md` with the adopted behavior during
  implementation; its existing signals section intentionally specifies the
  current timed actions and rail geometry.

acceptance: normal reading has no preparation warning card; held-position
return and ordinary retry take one activation; required explanation and primary
recovery are understandable before expansion. expansion, keyboard focus, coarse
pointer targets, narrow screens, themes and reduced motion work
without losing content, recovery or the reading position. routine bursts
aggregate without hiding unresolved work. verify the user examples first, then
migrate shared callers and specialized surfaces. use `./scripts/test` for
static verification and the owner's temporary live red/green/refactor/delete
campaign specified in the plan.

tradeoffs: secondary choices may cost an extra activation; multiple workspace
issues require expansion; domain-specific arrangements remain; transient
receipts have no permanent history; imports retains its existing observation
cadence. dimensions and visual quality still require rendered review. no
application code or live-browser behavior was changed or verified here.
