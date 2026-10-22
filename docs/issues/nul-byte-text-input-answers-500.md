# a NUL byte in text input answers 500 and logs the input

status: open · origin: 2026-10-20 python auth re-slice harness (journey A-V13) · area: api transport / every text input

`GET /users/search?q=a%00b` (any account) reaches postgres, which refuses the
text (`psycopg.DataError: PostgreSQL text fields cannot contain NUL (0x00)
bytes`); nothing models it, so the edge's last resort answers 500 `E_INTERNAL`
and logs `http.request.failed` with sqlalchemy's message, which carries the
bound parameters: the query text itself reaches the api log. afaict every route
that binds client text to sql shares this (search, titles, notes, names).

impact: a malformed request is reported as a server defect (500 rather than 400
`E_INVALID_REQUEST`), and request content lands in logs, which
`python/nexus/app.py` `_invalid_request` deliberately avoids for validation
errors. in notes a pasted NUL now fails only its own save ("note change not
confirmed"; the tab's write queue ends answered failures since the notes
re-slice), where it used to hold every later save in the tab; notes harness
journeys `api/A16` (still 500) and `bodies/B23`.

evidence: harness run `2026-10-20/auth/harness/runs/*` journey
A-V13.asgi-middleware-mechanics (main `f2025d935` and the slice alike); the
logged parameters `{'query': 'c3au\x00v13', …}`.

fix: refuse NUL in text at the request boundary (one pydantic/fastapi
constraint or one edge check: 400 `E_INVALID_REQUEST`), and keep sqlalchemy's
parameters out of the edge's failure log (`hide_parameters=True` on the engine,
or log the exception type only).

resolved when a NUL byte in a query or body string answers 400 and no request
text appears in the api log for it.
