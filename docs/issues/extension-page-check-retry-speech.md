# announce repeated page-check failures

an extension `retry_checking` that fails with the same message keeps the same failed fact mounted. enabling its initial speech does not publish a new occurrence for that retry.

source: `extension/background.ts:259,647,703` retains `checkingFailed` and `unsupported` through the retry. `components/feedback/Fact.tsx:140-145` changes its occurrence only when text changes; `Announcement.tsx:25` suppresses an already delivered occurrence. paths are under `apps/web/src/`. this is source evidence, separate from the observed initial extraction-refusal speech failure; physical assistive output is unobserved.

resolve at the existing page-check result owner. prove two actual identical failed checks publish two ordered polite occurrences while retaining the ordinary retry control, without fabricated responses or a forced remount.
