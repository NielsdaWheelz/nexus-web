# native lab download readiness was intermittent

problem: two isolated android runs did not reach download ready within the
caller's 60-second observation window. final ordinary parity passed; earlier
misses remain an unexplained lab repeatability concern, not a product latency
promise or an outstanding downloaded-reader parity gap.

evidence: source `7b062d659`, runs `20261028-193108-0f54391729dd` and
`20261028-194515-525b0839ea68`, owned android 15 emulator 5640, webview 124 then
159. enqueue succeeded; zero bytes stayed queued or retrying through 60 seconds,
with no reading-copy request and no force-stop after enqueue. a subsequent
standard-debugger diagnostic completed the real transfer; unrelated stream
cancellation/bootstrap timeout under debugger pauses do not establish its cause.

normal run `20261028-201503-b4d99d9ffe6a` at `26507b6e7` passed the full native
journey in 55.4 seconds on official chromium snapshot `159.0.8130.0`: ready,
restart, offline open and ordinary touch navigation to section 24. its api log
line 131 records the reading-copy post returning 200 in 435.24 ms.

resolved when ordinary isolated runs reliably admit the transfer, or a captured
miss explains the scheduler/network condition. inspect the owned package's job
state and constraints during a miss; do not force-run it or infer a product
network defect from absent requests alone.
