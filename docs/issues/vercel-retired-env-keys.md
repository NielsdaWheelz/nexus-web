# vercel production holds three retired env keys

vercel production still defines `API_PUBLIC_URL`, `STREAM_CORS_ORIGINS` and
`SUPABASE_URL`. no code reads them (checked at `2e154f053`, case-insensitive,
across `python/`, `apps/`, `docker/` and `deploy/`), and `deploy/env` dropped them
on 2026-10-22. they are inert, but `deploy/vercel/sync-env.sh` neither publishes
nor removes keys outside its lists, so they persist.

remove them from the vercel project's production environment. resolved when a
production `vercel env pull` holds none of the three.
