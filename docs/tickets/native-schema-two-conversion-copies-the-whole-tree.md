# schema-2 to schema-2 conversion still stages a full second copy

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading / conversion disk

## what is wrong

`OfflineReadingTableIndex.stageRetainedReadingPackage` deletes and recopies the
whole package tree, so the schema-2 → schema-2 conversion peak is a full second
copy of the document rather than one member.

the schema-1 half is contained: reconciliation now calls
`OfflineReadingStorageAdmission.canAdmit(freeSpaceBytes(stagingDirectory(bindingId)),
compressedBytes = 0, expandedBytes = installed.sizeBytes)` before
`migrationDirectory(...).mkdirs()`, and on refusal logs and skips without
creating the directory or copying a byte; the attested original is untouched and
a later reconciliation retries. the refusal is now visible as
`OfflineReadingAvailability.UpgradeBlockedByStorage` rather than an anonymous
`UpgradeRequired`.

## prerequisites

decide what "resume" means for a retained staging: the member-wise form must be
able to skip a member already staged and verified, and drop what the manifest
omits.

## proposed fix

stage member by member, verifying and retiring each before the next, so peak
disk is one member plus bookkeeping rather than a second whole package.

## acceptance

converting a large retained package peaks at roughly one member of extra disk;
an interrupted conversion resumes rather than restarting; a member the manifest
omits is dropped.
