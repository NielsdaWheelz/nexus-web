# offline reader settings reopening needs qualification

the account-settings change fixes the stale durable browser profile: the shared
device-settings refresh copies acknowledged settings through the binding owner,
and the reader awaits that copy. chromium’s public reader-theme save/reload
journey passes. reopening offline has not been observed; that remaining proof
must not be inferred from an online reload.

impact: normal reload durability is repaired, but the earlier offline-reopening
acceptance remains unqualified on the supported offline host.

evidence: `apps/web/src/lib/native/settingsRefresh.tsx` now orders reads and a
settings-only binding transaction under the shared browser lock;
`apps/web/src/lib/reader/ReaderContext.tsx` awaits refresh before marking clean.
account-settings chromium qualification observed the selected reader theme after
reload without mutating local storage.

resolved when a supported offline-host journey changes reader settings through
the product, closes and reopens its actual browser while offline, and observes
the same profile. no direct storage mutation or independent profile writer.
