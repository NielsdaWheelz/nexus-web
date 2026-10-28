# browser import recovery cutover

release requires paired api, workers, web and firefox extension. migration 0323
renames stored x capture bindings in upload origins and article-attempt payloads;
ids, bytes, packet paths, receipts, jobs and history survive. malformed bindings
abort the migration. no legacy reader remains.

before release:

- stop writers and workers through the existing release owner; take and verify
  a backup. preflight both json columns using 0323's exact conversion checks.
  resolve any rejected row from its original evidence; never invent identity.
- apply 0323 after contained-work metadata revision 0322. pair the rebuilt
  extension and web with api and workers before resuming capture. old browser
  drafts require recapture; valid pending server sessions survive conversion.
- wire 17 is already the pending break after the paired wire-16 release
  `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`. this change rides that bump.
  recheck actual activation before release; a newer paired release changes
  this decision. do not deploy mixed experimental wire-17 clients.
- qualify one selected failed ordinary import through the normal firefox
  interface: unchanged media/filing/inspector, readable publication, original
  failure retained, original-url re-add preserves browser provenance.
  no bulk repair or historical duplicate merge is authorized.

resolved after the exact paired release passes deployed qualification. local
implementation verification is not deployment. release remains unperformed.
