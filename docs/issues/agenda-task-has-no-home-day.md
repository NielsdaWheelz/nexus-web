# the agenda cannot name a carried task's home day

`node/authored/src/queries.ts` returns pending work as note projections in
capture order. a completion date describes work done. the query supplies no
dated source relationship. a note may also have several parents. the agenda
therefore cannot tell the reader which day first carried a task.

close when the meaning of home day is settled for repeated and unlinked notes,
the web and android query owners supply the same fact, and the agenda renders
it correctly for a task carried over from yesterday.
