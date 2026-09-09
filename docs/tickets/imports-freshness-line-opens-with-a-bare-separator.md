# The Imports freshness line opens with a bare separator while the page is unread

**Status:** open
**Origin:** Imports workspace cutover, Track F chain F-fix3 re-review, 2026-09-09,
found in the D15 layout-review artifacts
**Area:** `apps/web/src/components/imports/ImportsWorkspace.tsx` (Track E),
`apps/web/src/lib/status/imports.ts`

## What is wrong

`ImportsWorkspace.tsx` composes the freshness line as a matched-count segment
followed by a separator:

```tsx
{page.status === "ready" ? importsMatchedLine(page.matchedCount) : ""}
{freshness === null ? null : (
  <>
    <span aria-hidden="true"> · </span>
    <span className="sr-only">, </span>
    <span>{freshness}</span>
  </>
)}
```

The separator is rendered whenever `freshness` exists, but the first segment is
empty for every page status other than `ready`. While the list is loading, or
after a page read failed, the reader gets a line that begins with the separator:
`· Last checked now`, and a screen reader gets `, Last checked now`.

`importsSummaryLine` in `lib/status/imports.ts` already shows the intended
shape: it joins only the parts that are present with ` · `, so a missing part
takes its separator with it.

## Evidence

- `F-imports-review-2/zoom-200-mobile.png` and
  `F-imports-review-2/zoom-200-toolbar-wrap.png` (D15 review, journey run
  19d5f6fd6b63526f): the brief reads `· Last checked now` with nothing before
  the separator while the list still paints skeletons.
- `F-imports-review-2/zoom-200-mobile.aria.txt`:
  `paragraph: ", Last checked now"`.

## Prerequisites

None. `ImportsWorkspace.tsx` and `lib/status/imports.ts` are both Track E's
files; this was found from Track F's review artifact and is recorded here rather
than edited across the ownership boundary.

## Proposed fix

Compose the whole line where `importsSummaryLine` is composed: give
`lib/status/imports.ts` one owner that joins the present segments with ` · `
(and the screen-reader `, `), and let `ImportsWorkspace.tsx` render its result,
so the separator cannot outlive the segment it separates.

## Acceptance

A named case in `ImportsWorkspace.browser.test.tsx` reads the brief while the
first page read is outstanding and asserts the freshness line starts with the
freshness itself, and the same case covers the `ready` line still reading
`<matched> · <freshness>`. The next D15 capture shows no leading separator.
