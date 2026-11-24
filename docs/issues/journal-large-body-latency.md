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
the two-second save target remains open.

proposed acceptance: the same real nine-body fixture saves the entire title
within two seconds of final input, without repeated boundary-body transfer,
while forward joins, append, coherent
reads, native plan decoding and day-local history still pass. this is a separate
performance follow-up; rich-body virtualization remains outside the journal cut.
