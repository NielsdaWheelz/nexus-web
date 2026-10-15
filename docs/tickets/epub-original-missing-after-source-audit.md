# two previously verified epub originals now return nosuchkey

status: open; original source availability unresolved
origin: 2026-10-14 retained-book rehearsal storage preparation
area: retained source / object storage

the original for media `08d23b86-7042-4c72-bfe6-7faa5a696bee` was fetched
and hash-verified during contributor audit 007 at 2026-10-14 23:49:39–47 utc:
184,670 bytes, sha256
`77c2dee6253510f1e12fcd3b540b22f6936fd0cdec3d9aeb08beba62864a4c0a`.
a later get from bucket `media` at the same recorded path returned `NoSuchKey`:
`media/08d23b86-7042-4c72-bfe6-7faa5a696bee/source/2c98d3fc-be93-433c-aebf-e70bfcc0be76.original-epub`.
the copy packet's source record exactly matches the audit's before/after rows.
the cause, current production source pointer and any deletion actor are unknown.

source-based repair/recovery cannot use this recorded original. this does not
establish loss of the installed reader publication. the source copy stopped
before writing this object to rehearsal; no production object was written.
the earlier audit remains evidence of the earlier source, not current availability.

private evidence: `book-repair/c-sources/contributor-source-inputs.json`, sha256
`a369f3be13dfd3ed39207dd9375b1f81c23467e31047727930e53c05c101a9f4`;
`coordinator/contributor-source-copy-v1-transport.json` and retained stderr,
sha256 `9c8d6e65d42a2036968e3b483c028492b19da26c15c9c55253a296ca63872883`.
the successful frankenstein copy has its own receipt and is not rolled into a
passing two-object result.

bounded local searches found no exact original among 29,546 files and 21,203
members of 44 tar/zip archives in the retained release/campaign roots. no file
or member had the expected 184,670-byte size; there were no search errors.
this establishes absence only within those recorded roots and archive members.
private receipts in `book-repair/c-sources/`:
`contributor-missing-source-local-search.json`, sha256
`41d6351c66cca1f3c02efd838a9b706653f01c269dc05b0d3a9b41e63bfea1b6`;
`contributor-missing-source-archive-search.json`, sha256
`33ce92120919800622ccdb16a58f3b376313d1ab9a15f1d03eb5ab506f2d0f5c`.
the audit retained opf/observation evidence, not the complete archive.

the one reviewed alternate, media `37273127-1cc0-43b4-9ede-c88ff5f8c843`,
also returned `NoSuchKey` before any target intent or put. audit 054 verified
its 184,687 bytes at 2026-10-14 23:56:30–38 utc, sha256
`213296ac178edbbbbce57c8a33cf56f9d8913d343cfa1626d07e10f9e4823f5d`.
its source packet also exactly matches the audit before/after source rows:
`media/37273127-1cc0-43b4-9ede-c88ff5f8c843/original.epub`.
private copy evidence: `coordinator/contributor-alternate-source-copy-v1-transport.json`,
retained stderr sha256
`d3930cd53727d1843efc11eee32de400b5601fde803180aafb3a64be00c5c59d`.
the bounded local/archive search above covered the first original only.

the ordinary reader inspection independently returned `NoSuchKey` for
`37273127` at 2026-10-15 01:37:26 utc on operator source `150328b65`.
its source row still matched the earlier inspection. the final 230-book batch
stopped after 55 proposals, this one failure and 174 unrun items; it did not pass.
private terminal receipt: the `056-37273127` item under
`b-reader/final-review-150328-stopped56-evidence-v1/final-review-150328-v1/`,
sha256 `8b0c8d2a4602ccc83a399945db9ca8f990f8d8efe71461427fc8a25bf7648474`.
root independently reconciled terminal execution and absent database backends:
`coordinator/reader-final230-stopped-backend-reconciliation.json`, sha256
`8fafa5fe1aeb79b9b4c14fba97b8724298489b42ad57cec7302ef3735cb1263b`.

both audits used the real storage client and verified bytes before parsing;
neither mounted a substitute archive. retained invocation/source reconciliation:
`book-repair/c-sources/contributor-audit-storage-path-reconciliation.json`,
sha256 `accfd73f9a78e9c75f93747e0adad7e870cd60e50bcf9540f90ca0d7b3916b41`.
the storage owner passes the exact configured bucket and key without a cache,
rewrite or fallback. the local settings codec matches the direct copy
configuration; no evident path/config mismatch was found. private codec receipt:
`a-maintenance/storage-profile-codec-review.json`, sha256
`aee11084ad434f17ffdce43204c921bc79857d3f3d543c3c230cb32f8c702010`.
these checks do not establish the cause or current production source pointers.
further source reads require a separately reviewed exact scope.

next: after the production owner hands off, reconcile the current source row
and ordinary storage-cleanup history.
do not substitute another edition or reconstruct an archive from its opf.

acceptance: account for the recorded source/current source relationship and
prove the appropriate original readable with its exact byte count/hash; fix any
proved lifecycle defect before restoring or changing production objects. retain
an explicit unresolved disposition if the original cannot be recovered safely.
