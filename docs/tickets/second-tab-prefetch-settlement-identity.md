# an older prefetch can settle a replacement entry

- status: open
- origin: 2026-09-13 workspace architecture review; local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: resource cache ownership

`apps/web/src/lib/api/resourceCache.tsx:59–70` settles a prefetch whenever
the current entry for its key is pending. it does not check that this is
the same pending operation. `useResource.ts:132–135` consumes an adopted
pending entry; another ordinary hover can then start a replacement for
the same key. the older success overwrites that replacement; an older
failure deletes it. lru eviction followed by a new prefetch constructs
the same race. this is a source-proven race, not the measured cause of
the production api memory kills.

prerequisites: preserve the existing account-shell and seed ownership
contracts while repairing pending-operation accounting.

proposed fix: settle or remove only the exact pending entry owned by the
completing operation. retain adopted-operation accounting until settlement
as described in `second-tab-speculative-read-admission.md`. no new public
cache-generation protocol is needed for an in-memory object-identity check.

acceptance: an older success, rejection, or aborted eviction cannot replace
or remove a newer prefetch for the same key. a mounted adopter receives its
own result, and subsequent consumers receive the current operation's result.
run the focused behavioral proof through `./scripts/test`.
