# The upload transport vocabulary is decoded in two browser modules

**Status:** resolved (Track D2, 2026-09-08)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `apps/web/src/lib/imports/importsClient.ts`; `apps/web/src/lib/media/ingestionClient.ts`

## What is wrong

`UploadFailed` history facts carry `Presence<UploadTransportFailure>` — the
`Network | Timeout | Aborted | HttpRejected{status}` union of
`python/nexus/schemas/media.py`. `importsClient.ts` decodes it in
`uploadTransportFailure`; `ingestionClient.ts` already decodes the same union
in its private `transportReason` (as `UploadTransportReason`, for the failure
the browser *reports*). Two decoders now own one vocabulary
(`docs/rules/cleanliness.md`, Duplication).

They were not merged in Track D1 because `ingestionClient.ts` belongs to the
next phase and its helper is private; importing a private helper across modules
is itself a rule violation.

## Proposed fix

In Track D2, give the vocabulary one browser owner (its type, its decoder and
the browser-side constructor `ingestionClient` uses to report a transport
failure) and have both call sites use it.

## Acceptance

One module exports the upload transport union and its decoder; neither
`importsClient.ts` nor `ingestionClient.ts` declares a second copy.

## Resolution (Track D2, 2026-09-08)

`apps/web/src/lib/media/uploadVerification.ts` — the existing upload-vocabulary
owner — now exports `UploadTransportFailure` and `decodeUploadTransportFailure`.
`importsClient.ts` decodes `UploadFailed.transport` with it and `ingestionClient.ts`
uses the same type for the failure it reports and decodes; both private copies are
deleted.
