# native handoff ignores rejected session installation

status: open · origin: 2026-10-02 retained auth contract census, `ca1bb2e629` · area: native web auth

`app/auth/handoff/route.ts:136-147` awaits `supabase.auth.setSession` but
ignores its returned error/session, then redirects to the authenticated return
target. locked auth-js 2.108.2 `GoTrueClient.ts:3509-3565` returns
`{data:{session:null},error}` for an expected refresh or user rejection; it need
not throw. a successful internal token consume followed by provider rejection
therefore takes the success redirect without establishing the session. this is
source-contract evidence, not a hosted or actual route reproduction.

fix: classify the existing SDK session-installation result before success,
retain the established generic handoff failure/return-target policy and exact
cookie cleanup ownership. do not expose provider or consumed credential details.

acceptance: actual route + locked SDK against a controlled provider distinguishes
success, resolved credential rejection and dependency failure; no false success
redirect or surviving newly established cookie on failure. native handoff/return
contracts remain; `./scripts/test` passes.
