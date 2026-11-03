# extension save refusals become unknown outcomes

at feedback integration `e47819e34`, `extension/background.ts:1067-1074`
classifies a first create/confirmation failure as `Check` for status 401 or
every 5xx. the popup's `Check` branch says `not sure that saved` and retains
uncertainty. a 401 and `E_AUTH_UNAVAILABLE` prove non-execution under the shared
write contract (`lib/api/client.ts:120-136`); neither should create uncertainty.
the extension's separate `CaptureFailureError` transport is not classified by
that shared contract. no live extension reproduction is claimed yet.

preserve a previous unknown attempt through any later refusal. classify a first
known refusal at the capture request boundary, retaining its exact command for
deliberate retry. network/body loss, ordinary 5xx and database-busy remain
unknown after send. resolved when capture creation and confirmation follow this
partition, existing uncertainty survives a refused replay, and the popup's
fact and available actions agree. qualify actual extension behavior separately
from a simulated browser-port contract.
