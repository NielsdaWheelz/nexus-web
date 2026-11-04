# account write failed conflates refusal and uncertainty

identity unlink and email-change answer `Failed` for both preflight refusal and provider silence after a write. the client cannot infer nonexecution from this domain result. it conservatively retains the exact request as unknown, even when a preflight actually sent nothing.

evidence: `apps/web/src/lib/supabase/auth.ts` unlinkIdentity and requestEmailChange; `apps/web/src/lib/account/settings.server.ts` owns silent-write Failed results; `lib/account/settingsWire.ts` has no refused/unknown distinction. source inspection; no real external-provider timeout reproduction is claimed.

resolved when these fixed operations return a structured refusal versus unknown outcome and their owners consume it, without discarding prior uncertainty. no protocol change is included in feedback repair.
