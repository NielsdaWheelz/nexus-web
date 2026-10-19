# generation dead-letter inverts the tool lock order

status: open
origin: 2026-10-14 x title generation recovery review
area: queue and generation concurrency

the queue's dead-letter transaction locks its job before closing generations:
`python/nexus/jobs/queue.py:351–378`, `:383–401`, and `:641–646` invoke the
generation dead-letter hook while holding the job row. that hook updates
`llm_calls` in `python/nexus/services/generation/ledger.py:86–104`.

the tool fence takes the opposite order: generation, optional chat run, then
job (`python/nexus/services/tools/run.py:219–232`). a live callback overlapping
dead-letter settlement can therefore deadlock. PostgreSQL aborts a transaction,
so the risk is unnecessary failed work or recovery delay, not an unfenced commit.

no prerequisite. establish one lock order across queue reactions, generation
settlement and tool admission; retain atomic queue/domain settlement and the
exact execution fence. this inversion predates x title work.

acceptance: a real concurrent tool-fence/dead-letter interleaving completes
without deadlock and still rejects the obsolete execution's effects.
