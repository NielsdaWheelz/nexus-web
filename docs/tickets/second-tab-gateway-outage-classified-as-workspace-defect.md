# gateway outage is classified as a workspace defect

- status: open
- origin: 2026-09-13 second-tab crash investigation and user console trace; local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`, deployed sha `7e8fd48244b3b436965037738e05785bb4931be1`
- area: browser http error classification, bff, and nexus failure containment

the user supplied simultaneous 502 failures for contributor/works reads,
`/resource-items/openables/search`, activity, and reader-state writes, then
`Authenticated workspace bootstrap failed ApiError: Request failed with status 502`.
the failure also occurs during navigation within one pane. this evidence
supersedes the title-length hypothesis as the reported incident's explanation.

the source chain exists in both shas:

- `apps/web/src/lib/api/client.ts:250–287` maps a non-json or non-envelope
  failed response to `E_UNKNOWN`; deployed lines 181–218 produce the exact
  reported message.
- the same file's lines 81–89 classify every `E_UNKNOWN` as a same-system
  defect regardless of http status; deployed lines 50–58 are identical.
- `apps/web/src/components/nexus/useNexusController.ts:718–725` throws an
  openables/search defect during shell-mounted nexus rendering; deployed
  lines 713–720 do the same. this escapes the pane boundaries.
- `apps/web/src/lib/api/retryPolicy.ts:61–66` excludes that error from 5xx
  retries. `useResource.ts:208–226` also throws it during render.
- `apps/web/src/lib/api/proxy.ts:580–608` forwards a received upstream
  response verbatim but normalizes a rejected upstream fetch to `E_UPSTREAM`;
  deployed lines 555–583 have the same distinction. an intermediary's html
  502 can therefore reach the browser as though it were an owned api defect.

the [api incident ticket](second-tab-production-api-restarts.md) independently
confirms six kernel memory kills of the api and caddy connection refusals for
the user's exact contributor requests immediately after the latest kill.
the outage cause and frontend amplification are now correlated; the api's
allocating request and required memory envelope still need measurement.

prerequisite: preserve the reported response/request/build context and the
existing distinction between availability failures and owned api defects.

proposed fix: at the browser http boundary, model a gateway/service failure
without an owned envelope as an availability failure using its http status;
preserve structured owned errors and strict successful-payload decoding.
use the same classification in both browser response decoders. preserve
request ids from response headers when no envelope exists. normalize
intermediary failures at the bff where available, while covering failures
generated before the bff runs. contain nexus search/history defects below
the workspace owner and retain healthy panes, drafts, and last committed
data. retry reads within the existing bounded policy; replay writes only
under their existing identity/idempotency contract.

acceptance: inject raw html and non-envelope json 502/503/504 responses at
the browser and bff boundaries. existing panes and drafts survive, search
shows scoped recovery, and bounded reads recover when service returns.
structured `E_INTERNAL` and malformed successful payloads remain observable
defects in their owning feature boundary. request ids survive classification;
no mutation is blindly replayed. demonstrate regression sensitivity using
`./scripts/test` and verify against a controlled backend interruption.
