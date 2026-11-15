# the lab misses an orderly firefox pipe disconnect

status: open; observed in connections-scroll's temporary harness on 2026-11-02.

playwright hosted in bun can lose its firefox pipe without detecting the browser's
orderly exit. subsequent wheel, evaluate, goto and close calls wait for their bounds.
`build/reports/cases.md` records `pilot` a9 pid 75048 at 12:06:05.36 and `harden` a1
pid 3319 at 12:18:58.94: session checkpoints reached `quit-application-granted` and
`profile-before-change`; prefs were saved, without a crash/jetsam report. juggler's
`components/Juggler.js:disconnected` requests `Browser.close`, which quits firefox.
why the pipe closes is unproved; bun's extra-fd transport under load is a suspect.

headword recurrence: `20261114-180329-1d753b5b611b` reached a real firefox
workspace and the blank palette, then logged page/context close at
`1794708327896` during the first selection assertion, with no page-error or
crash event. subsequent screenshot and `close()` stalled. the owned lab received
sigint and confirmed teardown. private evidence: `/tmp/headword-qualification.log`.
the follow-up driver uses node with the same browser helper and assertions;
that can qualify the journey but does not establish or repair the bun pipe cause.

impact: a dead browser looks like a stuck product. temporary cases bound every
operation, inspect exact owned pids and main-thread activity, and retry one harness
failure after replaying its earlier passes. they never retry a busy-page failure.
this mitigation is not a repair to the shared harness.

resolved when the canonical lab browser transport reports an orderly child exit
promptly, all pending calls reject, and repeated scroll/census passes terminate
without the temporary retry. reproduce under load with playwright firefox in bun;
inspect its session checkpoints and owned processes before attributing a hang.
