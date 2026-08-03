# Lectern Editorial Surface Hard Cutover

**Status:** APPROVED SPEC · 2026-08-02

**Type:** Atomic hard cutover — no legacy path, fallback, compatibility shim,
dual composition, feature flag, or partial migration

**Scope:** One-user production-shaped prototype; smallest coherent Lectern body
repair

Follow [`docs/rules/`](../rules/index.md) and
[`docs/local-rules/`](../local-rules/index.md), especially cleanliness,
simplicity, boundaries, frontend, codebase, and testing.

This document owns only Lectern pane-body composition, the shared responsive
defects exposed by that composition, and affected frontend proof. The domain,
transport, provider, mutation FIFO, player, Slate, workspace, and pane-runtime
contracts remain authoritative in
[`lectern-player-lifecycle-hard-cutover.md`](lectern-player-lifecycle-hard-cutover.md),
[`resonance-reading-slate-hard-cutover.md`](resonance-reading-slate-hard-cutover.md),
and [`docs/modules/player.md`](../modules/player.md).

## Locked decisions

Open questions: none.

- Lectern is an editorial intention surface, not a dashboard.
- Resumption and user order outrank discovery.
- The primary queue is flat; it is never a card.
- `At hand` remains the one subordinate framed module and stays after the queue.
- The first item receives no new hero treatment in this cut.
- Existing data, behavior, commands, rows, and activation semantics are exact.
- Use shared primitives and shared owners; add no Lectern variant or design layer.

## Decision and final state

Replace the equal-weight card stack with the standard pane grammar:

```text
PaneShell / RunningHead                 existing continuity and chrome
  scrolling PaneSurface                one body-spacing owner
    SectionOpener: Lectern              body h1 and orientation
    semantic On-the-lectern section     flat, focusable recovery target
      CollectionView                    canonical ordered rows
    ReadingSlateSection                 subordinate At hand PaneSection
```

**Product principle:** the queue is sovereign; recommendations are courteous.

## Goals

1. Match the body hierarchy and rhythm of canonical collection panes.
2. Expose exactly one scrolling-body `<h1>` without duplicating pane chrome.
3. Recover the horizontal space consumed by the primary card frame.
4. Preserve every Lectern and Slate state, command, focus, and ordering contract.
5. Repair shared narrow-pane title/control allocation and opener scaling at
   their canonical owners, then delete superseded code atomically.

## Target behavior

| State | Required result |
| --- | --- |
| Any Lectern state | One standard body with a **Lectern** opener |
| Populated queue | Flat canonical rows in exact user order |
| Loading / failure / empty | Existing state and Retry behavior, without a queue card |
| Slate present | Framed **At hand** follows the queue and remains optional |
| Narrow pane | Opener steps down; titles clamp before visible, operable controls |

## Non-goals

- No backend, BFF, endpoint, payload, decoder, database, migration, cache,
  persistence, or durable-state change.
- No Lectern provider, mutation, replay, reconciliation, queue-order, player,
  Consumption, activation, or completion change.
- No Slate retrieval, ranking, reason, acceptance, refill, error, or focus-state
  change.
- No workspace, route, pane width, frame, chrome, scroll, history, memento,
  navigation, secondary-pane, mobile-host, or Android change.
- No first-item hero, cover art, source enrichment, kind badge, filter, chooser,
  shuffle, recap, session plan, recommendation dismissal, analytics, or agent.
- No new primitive, component variant, token, JS size observer, row renderer,
  view mode, repo-wide pane migration, or visual-regression platform.

## Ownership and intra-system composition

| Concern | Final owner | Change |
| --- | --- | --- |
| Frame, chrome, width, scroll, resizing | `PaneShell` / workspace | None |
| Domain state and writes | `LecternProvider` | None |
| Pane orchestration and focus fallback | `LecternPaneBody` | Recompose only |
| Top-level body slots and rhythm | `PaneSurface` | Reuse |
| Body heading | `SectionOpener` | Reuse; shared container adaptation |
| List states, sorting, and row publication | `CollectionView` | Reuse |
| Row anatomy and control allocation | `ResourceRow` | Shared narrow-layout repair |
| Lectern facts and actions | `presentLecternItem` | None |
| Recommendations | `ReadingSlateSection` / Resonance | None |
| Running-head count grammar | `Folio` input from Lectern | Use canonical `item` unit |

State path remains:

```text
LecternProvider.presentedSnapshot
  -> LecternPaneBody
  -> presentLecternItem
  -> CollectionView
  -> CollectionRow
  -> ResourceRow
```

Slate remains a sibling read model that receives only the host's canonical Add
capability. It never joins the queue state or mutation lane.

## Capability and API contract

### Lectern body

`LecternPaneBody` renders exactly one `PaneSurface`:

```tsx
<PaneSurface
  opener={<SectionOpener heading="Lectern" />}
  state={feedbackNotice}
>
  <section
    id={queueSectionId}
    aria-label="On the lectern"
    tabIndex={-1}
  >
    <CollectionView
      returnScope="Lectern.Items"
      ariaLabel="On the lectern"
      surface={false}
      {...existingQueueContract}
    />
  </section>
  <ReadingSlateSection {...existingSlateHostContract} />
</PaneSurface>
```

Rules:

- Delete the primary `PaneSection` and its import. Do not hide, restyle, or
  retain it behind a prop.
- The semantic queue section replaces the card only as the stable last-row
  focus target. It adds no visible frame, background, radius, padding, heading,
  state, or behavior.
- `SectionOpener` is once per surface, owns the sole body `<h1>`, has no
  standfirst or action, and scrolls normally.
- `CollectionView surface={false}` remains the only queue rendering path.
- Loading, failure, empty, populated, optimistic reorder/remove, and unknown
  outcome continue through existing owners and copy.
- `ReadingSlateSection` follows the queue and keeps its current `PaneSection`,
  title, region naming, state machine, Add control, and focus behavior.
- Publish `{ kind: "count", value: items.length, unit: "item" }`. Do not widen
  `Folio` or special-case pluralization.

### Shared opener adaptation

Replace the viewport-only `SectionOpener` display step-down with the existing
named `primaryPane` inline-size container. The primitive remains domain-free.

- Comfortable panes keep the current display scale.
- Panes at or below the current `34rem` threshold use `--text-2xl`.
- Use CSS container queries only; add no JavaScript width state.
- Preserve reduced-motion, pending, action, title-scale, and standfirst behavior.

### Shared row allocation

Keep the current `ResourceRow` props and activation API exact: `primary`,
`title`, `supporting`, `status`, `primaryControl`, `actions`, `expanded`,
`selected`, `as`, and `rootProps`. Add no option or variant.

Repair only shared geometry and markup required by these invariants:

- Visible title text participates in the same grid allocation as
  `primaryControl` and `actions`; it never paints beneath either.
- The interactive primary retains its current accessible name, focus ring, pane
  navigation metadata, and inert-row activation area.
- Primary controls, actions, and supporting links remain independent activation
  targets above row activation.
- At `320px`, `390px`, narrow desktop panes, and ordinary desktop width, title
  text clamps as today and the document gains no horizontal overflow.
- Fine- and coarse-pointer target contracts remain unchanged.
- Add no caller override, width estimate, hidden action, or Lectern-specific CSS.

### API and schema posture

There is no new public API, component prop, context, hook, registry, endpoint,
wire field, schema, persisted value, event, token, or environment variable.
Trusted existing shapes are consumed exactly. Unexpected states defect through
existing boundaries; add no normalizer or fallback.

## Visual and interaction rules

- Reuse `PaneSurface` spacing, `SectionOpener` typography, canonical row
  separators, and existing semantic tokens.
- The primary queue has no border, rounded enclosure, card material, shadow, or
  duplicate inset padding.
- `At hand` is visually subordinate because its frame communicates an optional,
  independently loaded module.
- Content identity and progress do the visual work. Add no decorative imagery,
  gradients, glass, glow, sparkles, faux paper, or skeuomorphism.
- Titles truncate before controls shrink, overlap, wrap into chrome, or become
  inaccessible.
- Preserve visible focus, logical properties, forced-colors behavior, reduced
  motion, and current touch targets.

## Files

### Add

- `docs/cutovers/lectern-editorial-surface-hard-cutover.md`

### Modify

- `docs/modules/player.md`
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`
- `apps/web/src/components/ui/SectionOpener.module.css`
- `apps/web/src/components/ui/SectionOpener.test.tsx`
- `apps/web/src/components/ui/ResourceRow.tsx`
- `apps/web/src/components/ui/ResourceRow.module.css`
- `apps/web/src/__tests__/components/ui/ResourceRow.test.tsx`
- `apps/web/src/__tests__/components/LecternPaneBody.test.tsx`
- `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts`

### Delete

- Primary-queue `PaneSection` composition and import
- Viewport-only opener refinement superseded by the pane-container rule
- Any helper, selector, comment, mock seam, import, or style made unreachable by
  the cut

No file outside this list changes unless it is proven to own an acceptance
criterion below. No production file is added.

## Proof strategy

Use static gates for decidable architecture and real Chromium for semantics,
layout, focus, and interaction. Browser-component tests retain owned React
collaborators and may stub only the `fetch` boundary.

Required focused proof:

1. Current populated composition fails the new semantic/geometric contract
   before implementation.
2. Lectern exposes one body `<h1>` named **Lectern**, a named queue list, and a
   later **At hand** region when Slate is present.
3. Empty, loading, failure/Retry, Slate absent, and Slate failure keep current
   behavior without restoring the queue card.
4. A populated mixed-media queue with long titles, progress, Play/Add, action
   menu, and reorder stays within `320px`, `390px`, and desktop hosts.
5. Each visible title rectangle ends before the first row control/action by at
   least the canonical gap; no horizontal overflow occurs.
6. Removal focus fallback, reorder, activation, nested controls, keyboard use,
   menu focus return, and architecture guards retain their contracts.

Run focused browser tests, architecture guards, CSS-token policy,
`make check-front`, then the existing Lectern real-stack journey. Review selected
screenshots at `320–360px`, `390px`, narrow multipane width, and ordinary desktop
width in Study and Press, including `200%` zoom, keyboard focus, forced colors,
and reduced motion. Do not add broad pixel snapshots.

## Acceptance criteria

- [ ] Every Lectern state renders through one standard `PaneSurface`.
- [ ] One scrolling-body `<h1>` named **Lectern** precedes the flat queue.
- [ ] The primary queue has no `PaneSection`, card frame, duplicate inset, or
  alternate rendering path.
- [ ] The semantic queue section remains the final-row focus fallback; `At hand`
  remains after it, framed and behaviorally unchanged.
- [ ] Running-head count reads `0 items`, `1 item`, or `n items`; malformed
  “lecterns” copy is impossible.
- [ ] Long titles never render beneath Play, Add, or action controls at required
  widths; no document horizontal overflow is introduced.
- [ ] Opener display scale responds to pane inline size without JavaScript.
- [ ] Remove, reorder, reset, playback, Add, Retry, unknown-outcome recovery,
  focus, and navigation behavior are unchanged.
- [ ] Canonical `CollectionView -> CollectionRow -> ResourceRow` anatomy and all
  public APIs remain mode-free and exact.
- [ ] Lectern joins the standard-pane inventory; superseded composition,
  imports, styles, comments, and unreachable code are deleted atomically; the
  player module links this final presentation contract.
- [ ] No behavior or file outside Scope changes.

Rollback is revert of the cutover commit. There is no runtime rollback path.
