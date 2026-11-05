# cancelled async connection initialization can fail a completed chat

status: driver correction prepared; cancellation and long-history qualification pending.

restored run `20261105-052527-2b4ef1e69616` admitted the fifth history turn, then
its worker failed with `Explicit rollback() forbidden within a Transaction context`.
the private `containers.log` records `chat_run_failed_unexpected` at
`2026-11-05T13:30:45.276823Z`; replay correctly refused to regenerate an already
started turn. both source cohorts and the preceding four history turns passed.

`services/generation/run.py:293` cancels its stop watcher after generation. on
the watcher's first async control checkout (`:325`), sqlalchemy initializes its
psycopg dialect and probes hstore through a native transaction context. pinned
psycopg 3.3.2 can leave transaction entry active after cancellation, so sqlalchemy's
initialization cleanup raises instead of preserving cancellation. no provider
payload failure is indicated.

this matches [psycopg issue 1451](https://github.com/psycopg/psycopg/issues/1451),
fixed in 3.3.7; [3.3.8 also reverts a 3.3.7 ssl regression](https://www.psycopg.org/psycopg3/docs/news.html).
upgrade the responsible driver, then verify cancelled entry leaves a usable
connection and independently visible commits, and rerun actual chat history
under the existing limits. do not hide the error or weaken terminal assertions.

the dependency now requires `psycopg[binary]>=3.3.8`, with driver and binary locked
to 3.3.8; sqlalchemy remains 2.0.46. the focused ignored case uses the upstream
native cancellation schedule, independent commit observation and explicit rollback.
