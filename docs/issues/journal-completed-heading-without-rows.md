# every journal day prints `completed` even when nothing was completed

found 2026-11-15 at fcd6843db, surveying the notes for a redesign.

## problem

`CompletedWork` renders its section and `<h3>completed</h3>` unconditionally once
the work history context exists. a day with no completed rows still shows the
heading over an empty list.

## impact

a heading that labels nothing, repeated under every day of the journal. it reads
as an unfinished or failed section.

## evidence

- `apps/web/src/components/work/CompletedWork.tsx:23`: `<h3>completed</h3>`, after
  only the `if (!history) return null` guard at line 21; rows come from
  `read.data?.rows ?? []` (line 26) and the section is never hidden for an empty,
  loaded result.
- the mount is `app/(authenticated)/daily/JournalPaneBody.tsx:276`, once per day.
- a lab photograph taken during the survey (not kept in the repo) shows the
  bare `completed` heading under a day with no completions; any fresh journal
  day reproduces it.

## resolved when

a day whose completed read has settled with no rows renders no heading (or says
once that nothing was completed); a day with rows is unchanged.
