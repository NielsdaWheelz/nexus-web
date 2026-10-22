# release: atlas and public share links, owed owner checks

status: shipped; owner checks owed
origin: the atlas and public share links; shipped in `83459f1b8` and `fdd0a3e`
(schema 0287, wire 2) on 2026-10-15
area: release / atlas and sharing

done: on `83459f1b8`, the production worker completed atlas job
`0788364e-6d1b-45f1-9bf1-4a0647ea119d` in one attempt. it positioned 508 media
in 10.77 s and cleared the lease (book campaign
`coordinator/final83459/worker-live/terminal-readback.json`). the release
acceptance left the atlas and share ui checks open
(`coordinator/finalfdd0a3e/usable-release-acceptance.json`). the owner deferred
the byte-read firewall split; [its issue](public-share-byte-rate-limit-plan.md)
owns it.

owed: no release record shows these in production. ordinary use shows the atlas
and share pages; these two concern what a link exposes, which it does not.

- open a public link to a large pdf, signed in and signed out. it makes one
  `bytes=0-` stream and a few chunk ranges, all 206 and none carrying a cookie.
  nothing more follows once the stream lands.
- open a revoked link; it reads share unavailable.

delete this file once the owner has run these or waived them.
