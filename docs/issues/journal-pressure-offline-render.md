# journal title rendering after offline reopen with oversized adjacent prose

the nine-body firefox rehearsal recovers the exact committed title and local
sequence after offline restart. at `960637d09`, the date was visible and
focused, with a pending day indicator, but its title did not render within
30 seconds. the reopened page then stopped answering geometry probes and
its browser driver timed out on close. the ordinary stock firefox restart
rendered the title and uploaded the pending sequence after reconnect.

evidence is `takeover-timing-960637d-033355/authored.json` and
`takeover-authored-controls-6ea76e9-030824/authored-stock.json` in the private
journal rehearsal. reproduce the oversized case with installed firefox and
independent process/worker observations. resolve when the focused date renders
the exact saved title offline and the owned browser closes cleanly.

the settled `70698c82b` replay verified the same timed write from the real
worker after a cold offline process start at a cached same-origin svg. its
134 ms save, exact sequence, and clean browser teardown qualify durability.
the oversized journal route's presentation remains unqualified at this source.
