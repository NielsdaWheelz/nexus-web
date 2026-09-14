status: open
origin: 2026-09-13 bounded pdf source review
area: pdf highlight mutation / foreground allocations

`pdf_highlights.py:184` finds duplicates with `query(Highlight).all()` for every
same-page/same-rectangle-count candidate, then loads and sorts each candidate's
quads. different quads can produce arbitrarily many candidates; their authored
text and geometry are materialized merely to answer an existence question.
selected-source filtering narrows identity but does not bound this allocation.

prerequisite: retain exact ordered, quantized-quad equality, source digest,
owner, page and existing duplicate-write lock. perform the duplicate predicate
in sql and return at most the matching identity; fetch its addressed anchor only
when the existing command needs it. do not invent approximate geometry identity.

acceptance: many same-page/same-count nonmatching candidates and a matching
candidate late in source order; create/link/edit keep exact duplicate semantics
without materializing all candidate records. real postgres proves the query and
maximum admitted mutation retains the resource budget.
