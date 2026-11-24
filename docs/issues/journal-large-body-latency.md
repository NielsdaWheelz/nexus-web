# large-body journal saving latency

an adjacent day containing nine roughly one-mib bodies can delay another day's
local title commits. the editor remains responsive and protects uncommitted
writing, but this is slow autosave.

at `fc7805a93`, the disposable browser check saved all 39 title
characters about 20 seconds after typing ended. passive worker observations
counted 42 completed outline reads carrying 43,473,150 projected text characters;
the tail proof still carries a complete body. evidence: the retained private
`20261110-052325-0637a90a40c7` pressure trace. normal-body checks passed separately.

the link-only boundary cut is implemented in `65e06c736`. the real baseline
firefox reply on the nine-body fixture carried 4,143,209 bytes for one selected
row and included two boundary bodies. the candidate's production sqlite decoder
probe returned a 1,156-byte passive slice in its smaller fixture and the full
explicitly selected body. raw cursors, child alignment and causal link stamps
were checked there.

the full firefox fixture at `723d09a81` returned 2,396 bytes for the
passive slice and 2,072,821 bytes for the explicitly selected large row.
the proof had no boundary resources. evidence is
`takeover-d-723d09a-021709/authored.json` in the private journal rehearsal.

the focused replay at `9aff45f4b` held the target title, observed the remote
clear, clicked into the now-empty editor and entered all 39 characters.
17 target updates committed before the 75-second observation ended. the trace
recorded zero boundary body bytes, roughly 31 mb of selected text for the
adjacent day, and 414 mb of causal state reads for its nine unchanged notes.
most came from direct resource subscriptions requerying on every corpus change.
evidence is `takeover-d-focused-9aff45f-023234/authored.json`.

at `6ea76e995`, the exact 39-character title survived an offline firefox process
restart. the final durable acknowledgment took 25,647 ms. causal reads fell to
7,991 bytes after direct resource invalidation was scoped by ref. the adjacent
day still returned 66,239,936 bytes of legitimately selected prose across 64
replies during the edit. evidence is `takeover-timing-6ea76e9-031736/authored.json`.
`65517d936` removed the unrelated outline and index reads. the same replay
recovered the exact durable title again and took 2,786 ms. it still queued 156
unaffected work queries. evidence is `takeover-timing-65517d9-032643/authored.json`.
`960637d09` removed those queries and took 2,364 ms with the same exact durable
title. the app still reapplied local title updates when they arrived in its own
server feed. evidence is `takeover-timing-960637d-033355/authored.json`.
`d74a3b298` made those echoes cursor-only, yielding consecutive revisions 4–42
for command sequence 1–39. the save still took 2,861 ms in that run. it queried
the already-held target resource and its causal state 38 times in addition to
fetching the target outline. evidence is `takeover-timing-d74a3b2-034522/authored.json`.
the two-second target remains open until the same replay qualifies.

proposed acceptance: the same real nine-body fixture saves the entire title
within two seconds of final input, without repeated boundary-body transfer,
while forward joins, append, coherent reads, native plan decoding and day-local
history pass.
