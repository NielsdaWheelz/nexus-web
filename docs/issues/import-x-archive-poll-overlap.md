# x archive polling can abort its own slow read

the x archive presenter discards the promise returned by its read owner. while
archive work is queued, running or recovering, each two-second interval can
invalidate and abort an earlier archive read that has not completed. slow
connections can therefore keep the archive state from advancing.

evidence: `apps/web/src/app/(authenticated)/media/[id]/Embeds.tsx:161-162`,
`apps/web/src/lib/useIntervalPoll.ts:26-39`, and
`apps/web/src/lib/api/serverState.tsx:133-139,770-781`, at held head `1b63b570`.
this is a source-proven inherited promise-loss path, separate from the accepted
source pane repair. no x archive runtime reproduction has been qualified.

return and handle the read promise at the existing poll owner, or use that read
owner's established passive revalidation contract if appropriate. resolution
requires a real archive read held beyond two ticks remaining the original live
request, then completing and advancing the actual archive presentation.
