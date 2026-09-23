# upload session contract exports an unread outcome list

status: open · origin: 2026-09-23 firefox v1 refactor pass · area: web / `lib/media/uploadSessionContract.ts`

## problem

`UPLOAD_IDEMPOTENCY_OUTCOMES` is exported but read only inside its own module.
The export exists because the phase-0 freeze named it and
`tools/firefox-harness/phase0-contracts.test.ts` pins the module's exact export
list; no runtime importer ever appeared.

## impact

dead public surface on a shared contract module; harmless at runtime.

## evidence

`grep -rnw UPLOAD_IDEMPOTENCY_OUTCOMES apps/web/src` → only
`uploadSessionContract.ts` (declaration and two internal uses).

## fix

drop the `export` once the temporary phase-0 harness is deleted (the test's
export-list assertion is the only reader).

## acceptance

`UPLOAD_IDEMPOTENCY_OUTCOMES` is module-private; `bunx tsc --noEmit` and
`bun run lint` pass; no harness references it.
