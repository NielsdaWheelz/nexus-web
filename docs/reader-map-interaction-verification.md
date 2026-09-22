# reader map interaction verification

status: implementation and chromium software acceptance passed; physical device acceptance remains in
[oi-069](tickets/reader-map-inert-position-and-mobile-controls.md)
observed: 2026-09-22
candidate: `feat/reader-map-interaction` atop `e41f05e5877617a89d5687c1e14e8199d00426d4`

## method and result

temporary scripts drove chromium 147 against the real next bff, fastapi,
postgres and supabase auth stack with a disposable account, article,
highlights and notes. no response, application route or clock was mocked.

- red: 12 of 23 controls passed and 11 intended failures reproduced the old
  displaced targets, clipped popup, duplicate quote, absent annotation and
  dismissal defects
- green: the final current-tree rerun passed all 23 core checks; composed
  follow-ups passed resize, 200%
  scale, endpoint, scoped-detail, short-viewport, focus/hover arbitration,
  source replacement and note save/delete refresh in both hosted rails
- coarse input: every target was at least 24px in both axes, same-lane targets
  were disjoint, all sampled centers and edge midpoints belonged to their
  button, and the resize handle remained usable in gaps
- mobile: 7 of 7 checks passed. the opener owned its center, the popup followed
  a real 48px sheet translation within 0.31px, a newer modal made it ineligible,
  host removal left no popup, and durable reading state was unchanged
- focus settlement preserved an intentional external focus target through
  2.55 seconds after chooser escape. cdp exposed one exact quote through the
  described tooltip, rather than repeating it in the trigger name
- forced colors retained a 1px `CanvasText` fixed-chrome divider and the full
  52px rail. all 24 horizontal pixels of the boundary coarse target remained
  owned by its button
- the deleted pure contract check passed seven named geometry boundaries, 250
  deterministic property cases, strict projection, no-quote, missing-note,
  note-order and duplicate-named-content cases. live database variants also
  rendered `no text quote` and `no note preview` through the real aggregate
- a 21-check native matrix reached contents, embed, link, source-reference,
  highlight, synapse and current-position destinations by pointer and keyboard
  with exact identities and group membership. the document's footnote citation
  correctly projected as `SourceReference`; `GeneratedCitation` was unavailable
  because it belongs to the distinct authored-chat connection path
- a disposable two-page pdf produced one geometry-only highlight through the
  real aggregate at 62.5–65%, with `pdf_page_geometry`, no quote or excerpt and
  no diagnostic omission
- the production-built offline bundle passed with a protocol-valid android
  bridge and reader package: 12 groups, shared preview, a three-member
  current/contents chooser, escape focus return and no page errors
- before and after the activation matrices, reader locator/revision and maximum
  progression were identical; activity spans and completion facts remained zero

adversarial source review found no remaining blocker in layout, projection,
popup/modal lifetime, focus/history settlement, caller migration or legacy
removal. the final `./scripts/test` run passed formatting, python static checks,
the offline production build, css-token checks, eslint, next type generation,
typescript and the migration graph at `0240`.

## limits

no android device was attached. physical webview touch and screen-reader
announcements, plus the downloaded-reader operator review, remain in oi-069.
firefox and safari were not run; only chromium 147 was installed on this host.

the temporary browser scripts, fixtures, database and dependencies were
deleted. no automated regression suite remains, by request.
