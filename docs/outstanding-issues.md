# Outstanding Issues & Follow-ups

A register of **open code-level work** — issues found but left out of scope, bugs,
refactors deferred because they were too much churn, and things that warrant a
closer look later. **Add entries as they surface; delete them once resolved (record
the fix in the commit/PR). This doc tracks only outstanding work, never history.**

It is **not** a checklist for routine verification (running test / e2e / CSP
suites), release process (commit / PR / merge), or already-settled design decisions
— those belong in CI, the PR, or the relevant spec/memory.

Currently leans toward the Universal Launcher hard cutover (the active branch) but
is repo-wide: tag each entry with an `area`.

## How to add / update an entry

- Copy the template below, give it the next free `OI-NNN`, append it under `Open`.
- **Statuses:** `OPEN` (actionable now) · `DEFERRED` (blocked on a decision or
  another change).
- Keep the one-line metadata: `area · opened YYYY-MM-DD by <name/agent> · P0–P3`
  (P0 = ships-blocking, P3 = nice-to-have).
- When an entry is resolved, **delete it** — record the fix in the commit/PR.

```
### [OPEN] OI-000 — <short title>
area · opened YYYY-MM-DD by <who> · P2
<the code issue / bug / investigation, why it matters, and how to resolve>
```

---

## Open

### [OPEN] OI-001 — Prune dead backend `CommandPaletteTargetKind` enum members
launcher/backend · opened 2026-06-18 by Claude · P3
After the cutover the Launcher only ever logs `target_kind:"href"` selections, so
the `"action"` and `"prefill"` members of `CommandPaletteTargetKind`
(`services/command_palette.py`) are now dead writers. Hard cutover ⇒ no legacy code
should linger.
**Resolve:** confirm no other caller writes `action`/`prefill`, then drop those
members + their `_normalize_target_href` branches and update any tests.

### [OPEN] OI-002 — Bare-URL hard signal is dropped when the URL has trailing punctuation
launcher/parse · opened 2026-06-18 by Claude · P3
`parseLauncherInput` only treats input as a bare-URL add-signal when the whole text
equals the extracted URL. `extractUrls` strips a trailing `[),.;!?]` from the match,
but the gate compares the cleaned URL against the *un*-stripped `text.trim()`, so
e.g. `https://example.com.` (trailing period) fails the equality check and does
**not** surface the "Add ⟨host⟩ to library" top row (AC-2). It's a safe-direction
miss (never a false add), which is why it was left, but it's a real edge-case bug.
**Resolve:** strip the same trailing-punctuation set from `text.trim()` before the
equality check in `parseLauncherInput.ts` (one-expression tightening); add a case to
`parseLauncherInput.test.ts`.
