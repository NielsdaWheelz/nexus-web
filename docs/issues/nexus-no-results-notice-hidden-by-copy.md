# the palette hides the empty-search notice by its wording

status: open · origin: 2026-11-02 palette s3 · area: web / nexus notices, search progress

zero principals say so on `search all results` (`nothing matched here`), and the
row sheet deletes the `no results found.` notice band. the shared
`searchProgress` (`lib/search/progress.ts`) reports an empty search as a `Notice`
with that text and no action, the same kind it uses for real problems
(`scope unavailable…`, `search couldn’t be completed.`). `NexusNotices`
(`components/nexus/NexusRow.tsx`) therefore drops the notice by comparing its text
to `"no results found."`.

impact: a copy edit in `progress.ts` would bring the band back silently.

fix: give the empty outcome its own progress kind (or let `useNexusFind` map it
away) so the palette branches on a tag, not a sentence.

resolved when: `NexusNotices` has no string comparison and a zero-result query
shows no notice band.
