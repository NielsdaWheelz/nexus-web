# local web port is not forwarded to next

status: open. origin: resource-reference merge verification, 2026-10-16.
area: local development.

`Makefile:web` uses `WEB_PORT` for `APP_PUBLIC_URL` but invokes `bun run dev`
without supplying the listener port. `apps/web/package.json` runs `next dev`,
which defaults to 3000. with `WEB_PORT=3376`, the app therefore listens on 3000
while its auth/origin contract expects 3376. supplying `PORT=3376` to the same
workflow fixes this isolated setup; it does not fix the documented command.

make the web owner pass its configured port explicitly. resolved when
`make web WEB_PORT=3376` binds 3376 and uses the matching public origin without
requiring a separate `PORT` value; default-port behavior must remain correct.
