# mobile nexus header needs text-zoom qualification

at `7ed9cb0b2` (base `f50007bce`), the unchanged mobile header's search heading
overlaps the account text button at 390 px width and 200% root text. observed in
run `20261028-175657-5727ab7090e1` mobile oversize-head screenshot; guidance and
header are independent issues. owner: `components/switchboard/SwitchboardTask.tsx`
and `components/nexus/Nexus.module.css`, under `apps/web/src/`.

main `aac38e09a` already changes this header to shared icons. the compact palette
branch starts there; preserve that landed owner rather than repairing old header
markup in this branch. resolved when the integrated header is verified at 390 px
and 200% text with distinct controls and unchanged minimum touch targets.
