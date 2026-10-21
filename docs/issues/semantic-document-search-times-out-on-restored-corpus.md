# restored-corpus search misses its latency target

status: open · origin: 2026-09-15 pr #270 · area: search · oi-134

owners: `search/discovery.py`, `search/sources.py`, `search/semantic.py`.
browser phase separation and cancellation bound waiting, but complete retrieval
still misses the progressive-search latency contract. production previously took
13–16 seconds for ordinary document search; the measurements below are isolated
restored-clone evidence, not production or browser-paint qualification.

candidate `efd7e19bbc4cf720d30c059328feaf424cef076d`, canonical 0305, uses the
reviewed 8a67 backup: 834 media and 721,079 chunks/embeddings. original postgres
limits are 512 mib/1 cpu, 64 mib shared buffers; the separate runner is 384 mib/1 cpu.
240 actual lexical-resource handler reads, 20 per query/scope, produce 184
successes and 56 timeout 504s. `love` all/library succeeds 0/20 each; `pillow`
library succeeds 5/20 with 1.184-second p95; `keats` library succeeds 20/20 with
854-ms p95. all outcomes contribute to tails. timings include operation cleanup
and exclude authentication, http transport, debounce and paint. the first-page
lexical target is 750 ms including browser costs; a timeout is not a latency pass.

current plans justify transaction-local jit off, narrow chunk ranking facts and
two apparatus indexes. all 48 representative responses retain results, order and
evidence after intentional phase/status/cursor normalization. the 0305 oracle
also preserves protected identities, source text/selectors and stored vector values.
materializing scalar ranking facts made the dominant statements slower and was
rejected. corrected jit-off common chunk plans take 1.49–1.57 seconds with only
56–60 ms of summed reads: warm non-io work remains material. the original warm
interval adds 1,834 memory-limit events, with no oom/kill.

separate buffer-cold reads, restarting only owned postgres before each cell,
produce nine successes and three timeouts across twelve cells. host caches are
unknown; one observation per cell establishes no cold tail. three healthy
supersession checks observe both exact backends active, the obsolete backend gone
6–7 ms after disconnect, and no leaked tasks. one replacement still times out.

owner-authorized private cache trial: 2 gib, 256 mib shared buffers, same 1 cpu.
80 capped broad-scope reads produce 22 successes and 58 timeout 504s, versus 24
successes for those cells in the original envelope. `love` all/library remains
0/20 each. postgres consumes 63.8 cpu-seconds; peak memory is 1.29 gb, with no
memory-limit or oom events. increasing cache alone fails acceptance. production
was unchanged; all owned diagnostic containers are stopped, with private data retained.

hybrid has a separate scoped ann cost. the genuine `pillow` vector's baseline
largest-media query uses `ix_content_embeddings_vector_ann` but takes 5.14 seconds:
11,313 index rows undergo order-preserving scope/model/readiness checks before the
outer 200-neighbour window. there is no lost-order outer sort. broad ann reads take
0.20–0.32 seconds, without a collected broad plan. current source in the larger
trial instead gets an owner-first plan over 20,137 chunks, top-n 200: 638 ms first
read, 116 ms warm. source and capacity differ, provider time is excluded, and no
cosine-eligible neighbour is returned in that scope. this establishes neither a
causal cache improvement nor semantic recall/latency acceptance.

next decision: exact current ranking with further measured cpu capacity, or a
native indexed relevance contract with explicit ordering/representative changes.
no arbitrary candidate cap, dropped family, inner ann limit or deadline increase.
resolved when complete phases meet their declared first-page targets on exact,
rare, common and paraphrase queries in all/media/library scopes, with warm and cold
observations separate, actual browser costs included, and protected access,
owner grouping, evidence and recall contracts qualified.
