# synapse and slate: product questions for the owner

status: open (owner decision) · origin: 2026-10-04 synapse reauthor (spec §7, design §14, branch cleanup/synapse-reauthor) · area: synapse / resonance

the rewrite kept these behaviours unchanged on purpose; each needs an owner
decision before anyone changes it.

1. trigger policy (spec Q1). every highlight create, pdf highlight create,
   media unit ready and note reindex (every note edit) queues a scan, and each
   scan with candidates costs one model call. this is the main cost and
   backlog lever (see `production-synapse-scan-statement-timeout-backlog.md`).
   option: scan automatically only on `media_unit_ready`; scan highlights and
   notes on demand.
2. manual scan for media and highlights (Q2). ✦ is offered on note-block and
   page Connections only; media and highlights are scanned only automatically.
   option: a ✦ in reader Evidence for media.
3. the Similar lane's work vector (Q5). a media anchor's first chunk vector
   stands for the whole work. option: a document-level embedding.
4. quick reads include Lectern members (Q7). `GET /lectern/quick-reads` has no
   member exclusion, unlike At hand. intended?

5. the source side of "already related" (design Q3). the far end of every
   relation counts at work grain, and dismissals count at work grain on both
   ends, but relations are read from the source itself: a highlight's scan may
   propose a work its media is already linked to or already proposed. counting
   the source at work grain too (its media and everything that media owns)
   left the harness's highlight scans with nothing to propose (4 and 1
   proposals became 0 and 0 on the six-media corpus): every passage-level scan
   in a well-connected book would be starved. options: keep exact (today),
   count only human links at work grain, or count everything.

acceptance: each item has a recorded decision; any change it implies gets its
own ticket.
