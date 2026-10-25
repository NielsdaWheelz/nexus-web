# fatal workspace failure retires the loss guard before unsaved input

an editor failure reaches `AuthenticatedWorkspaceErrorBoundary`, which replaces
its authenticated subtree (`apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx`).
that unmounts the editors and, for the outer boundaries in
`lib/authored/BrowserWorkspace.tsx` and `lib/native/DeviceWorkspace.tsx`, `WorkProvider`;
its cleanup removes exit listeners and clears owners (`apps/web/src/lib/unsavedWork.tsx:143`).
`WritingRuntime.close()` correctly refuses to discard an uncommitted failure
(`apps/web/src/lib/notes/runtime.ts:199`), so words remain in memory.

change made (not yet proven live): the boundary's stopped surface now guards
`beforeunload` and `nexus:request-exit` with `hasUncommittedWriting()`, routes the
stale-build reload through the same loss confirmation, and, inside an account,
shows `couldn’t save on this device` / `keep this page open. retry saving.` with
the runtime's own `retry()` and a copy of exactly the uncommitted words
(`WritingRuntime.uncommittedText()`: open documents the failed command touched and
the current command's created body/title; read-only, no store or history). when the
clipboard is unavailable the words appear read-only for manual selection. no durable
recovery was added.

remaining gaps:
- the outer boundaries render outside the account provider. the boundary accepts an
  optional `accountId` for them; `lib/authored/BrowserWorkspace.tsx` and
  `lib/native/DeviceWorkspace.tsx` (not this owner's files) must pass
  `binding.account.account_id` before retry is offered there. exit and reload are
  guarded either way.
- `WorkProvider`'s own exit risk still ignores `hasUncommittedWriting()`, so closing an
  editor pane after a failed local save relies on that editor's own registration.

resolved when a real failed local save followed by a render failure still guards
browser reload and native exit and permits retry (or copy) of the retained input.
