# epub find retains unused transport injection

status: open
origin: 2026-09-21 cleanup reader audit at `93563d12b6`
area: web epub find

`apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.ts:115` defines
transport function types solely for optional `findOccurrences` and
`loadFragment` inputs at lines 144-145. the private adapter constructor
defaults both to existing request functions at lines 347-348. its only caller,
at line 1008, never supplies either option; repository search found no others.

impact: dead injection surface and indirection obscure the actual transport
owner. there is no surviving test caller.

prerequisites: none. call `requestEpubFind` and `requestEpubFragment` directly;
remove optional inputs, their function types and now-unused imports.

acceptance: `./scripts/test` passes and the adapter retains the same request
arguments, error handling and cancellation signals.
