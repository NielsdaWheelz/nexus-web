# the client still retries every 5xx, including deterministic refusals

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: client transport / retry policy

## what is wrong

`apps/web/src/lib/api/retryPolicy.ts` decides retryability with
`error.status >= 500` rather than an explicit closed set of retryable codes.
`docs/rules/errors.md:18-19` criticises exactly that rule: a deterministic
refusal that happens to be given a 5xx status is then retried three times before
being reported.

this cutover's own terminal refusal dodged it by accident:
`E_READER_CONTENT_TOO_LARGE` is 422 and is therefore mechanically
non-retryable, which is why the client plan recorded "retryPolicy.ts, proxy.ts,
client.ts: NO edits". the blanket rule is still there and will re-admit the same
class of bug the next time a deterministic refusal is given a 5xx.

## prerequisites

enumerate which server codes are genuinely transient (`E_READ_CAPACITY` with
`Retry-After`, gateway 502/503/504) versus deterministic. the set must be the
client's, not inferred from the status class.

## proposed fix

replace the status-class test with an explicit retryable code set, and make an
unknown 5xx non-retryable by default so a new deterministic refusal fails closed.

## acceptance

a deterministic refusal returned with a 5xx status is reported once, not four
times; a capacity refusal with `Retry-After` is still retried on its schedule.
