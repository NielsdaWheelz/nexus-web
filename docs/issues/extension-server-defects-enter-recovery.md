# extension server defects enter ordinary capture recovery

the extension's request adapter accepts any error-envelope code as a
`CaptureFailureError`, including `E_INTERNAL`, `E_UNKNOWN` and
`E_INVALID_RESPONSE`. `background.describe` returns that error unchanged; a
sent create/confirm 500 can become recovery `Check` and an ordinary unknown
hold instead of the capture-stopped defect path. new refusal copy hides the
server prose but does not repair that classification.

evidence is source-only at `6d463695`: `apps/web/src/extension/nexusClient.ts:159-164`,
`background.ts:454-457,1058-1088` and `popup.tsx:497-517`. the broad adapter predates
this cut; no runtime defect was induced. stored domain failure codes are a
different boundary from an unsuccessful HTTP error envelope.

trace the actual envelope producer and preserve the frozen command and any prior
uncertainty while routing undeclared server defects through the existing host's
stopped behavior. resolved when a real packaged-addon consumer demonstrates that
separation, without claiming a failed or unacknowledged write did not commit.
