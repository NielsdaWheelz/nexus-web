# journal physical fling qualification

the target gesture is a large two-finger trackpad fling in stock desktop firefox.
headless firefox 160 travelled 111,078 px down and 107,922 px up in a 480-page
archive at `9e7a018e2`, with no motion-time scroll writes or reversals. that run
also passed native smooth travel. these observations cover scrollbar drag and
smooth movement.

the approved headed profile reached the archive. at the end of its time box,
geckodriver returned an unknown error on terminal readback. no physical trace
was recovered. no completed human gesture was reported. the owner deferred a
second check on 2026-11-24.

resolve with a separately approved disposable headed profile. capture the trace
incrementally while it is open. require a trusted multi-page trackpad fling in
both directions, monotone travel and zero authored scroll writes during travel.
record the reader's observation and private-profile teardown separately.
