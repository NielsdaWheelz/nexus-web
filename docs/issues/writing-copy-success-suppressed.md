# completed recovery copy can lose its acknowledgement

lab7 `writing-decisions.spec.ts:192` completes the copy (201), verifies its exact
rich body and the unchanged original canonical body, then cannot find the success
acknowledgement at line 256. trace: the earlier offline workspace put leaves a
`workspace changes not confirmed` condition when `NoteNotices.tsx` calls
`feedback.receipt`. `workspaceSignals.ts` deliberately drops receipts while a
condition exists. the condition later clears, leaving no copy acknowledgement.

the successful-retirement path now uses the existing dismissible `draft-copy`
offer, matching the completed-copy/original-retirement-refused path. the latter
keeps its precise original-draft message; successful retirement needs no message.
ordinary sync and global receipt priority are unchanged.

awaiting verification: prove both copy journeys, including newer original input
and an unrelated active workspace condition. no checks or runtime verification
have run for this fix.
