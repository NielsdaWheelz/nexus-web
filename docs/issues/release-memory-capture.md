# shared memory capture cutover

the capture source and central `nexus-turn-capture-v1` contract must ship together.
source implementation alone does not enable capture. no production cutover has
been performed.

- drain admitted runs before the existing stopped-writer cutover changes capture
  settings; do not restamp old runs or reset an established boundary.
- publish generated client and publisher files from one sharing declaration.
  active capture requires matching owner/capture/admit. capture-only client has
  `connect=false, bearer=null`; disabled publisher is `null`.
- upgrade through migration `0346`, then start the paired release. background
  alone receives the upload file. api/interactive receive only the client file.
- inspect `nexus memory-capture-status`. one synthetic owner turn must reach the
  central archive through the real publisher and disappear from pending only
  after its exact receipt. inspect native internal exclusion too.
- disable without deleting pending exports. repair a parked cause before
  `nexus memory-capture-retry <capture_id> <export_seq>`; never skip a sequence.

resolved when the installed paired release has that functional evidence and the
owner's intended flags. historical import, backup/restore and usefulness/load
evaluation remain separate work.
