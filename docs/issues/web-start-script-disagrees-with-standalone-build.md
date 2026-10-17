status: open
origin: 2026-10-16 find-bar frozen-build verification, `d03fc1ff3`
area: local web startup

`apps/web/package.json` declares `start: next start`, while
`apps/web/next.config.ts` selects `output: "standalone"`. the frozen build's
start log says: `"next start" does not work with "output: standalone"
configuration. Use "node .next/standalone/server.js" instead.` it still served
the 14 browser cases; this does not establish that the command is supported.
the task's subsequent local check uses the generated server with copied static
and public assets. production deployment is outside this finding.

prerequisite: decide which local build/start entrypoint has an actual owner.
align that entrypoint with the generated artifact, or remove an unused command;
retain one documented path.

acceptance: build and start through the supported entrypoint without this
warning; page, client chunks, fonts and pdf worker load successfully.
