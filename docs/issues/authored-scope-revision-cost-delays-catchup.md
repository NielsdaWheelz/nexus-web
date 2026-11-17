# scope metadata delays authored catch-up

2026-11-17, source `4ea24bcaf`: an isolated runtime-role read-only owner probe
measured status at 372 ms, first metadata at 5,703 ms and its continuation at
5,520 ms. the metadata statement spent 5,247/5,078 ms fetching, after only
54/57 ms declaring its server cursor. neither page reached the per-part
incomplete-table queries. this isolates metadata generation as current work,
not the older per-reference sweep or a demonstrated revision-fence bottleneck.
the retained browser journey still encountered five-second image checkout
refusals. private evidence: `f-probe-aaaa7635-d460-4fae-b48c-e489cd01146e-metadata.json`.

on deployed `d05d69bd18afceb588ae7f74598043dd3068b3e5`, 2026-11-16,
`/authored/scope-inputs` returned 200 repeatedly in 11.0–14.6 seconds, while
authored changes returned 200 in 10–22 milliseconds. the retained firefox
client still displayed “syncing”; completion of scope hydration and the badge's
remaining cause have not been established.

`python/nexus/services/authored/scope.py:286–344` still computes the canonical
revision from the account's complete scope facts. `inputs` invokes it before
each status or metadata response. the per-reference authority sweep is fixed:
the deployed owner uses one statement, and an isolated restored-corpus check
matched the previous revision and authority decisions for 99 allowed, denied,
missing and repeated references. that removes the serial scans, not the
remaining corpus work.

the final deployment retained account head 1338, desktop accepted prefix 206,
mobile accepted prefix 517 and the exact cross-device note body. this is not
evidence of acknowledged writing loss or of a completed sync badge. android's
writing and cold catch-up journey passed on the preceding `b666d936f` cohort;
it was not rerun on `d05d69bd1`.

resolve the measured metadata cost and establish which unfinished lane keeps
the badge busy. qualify ordinary resumed catch-up and its truthful terminal
state against representative stored data, preserving exact revision bytes,
permissions and accepted source prefixes. do not hide the work with larger
pools or timeouts. request cancellation remains a separate
[issue](api-sync-work-outlives-request-cancellation.md).
