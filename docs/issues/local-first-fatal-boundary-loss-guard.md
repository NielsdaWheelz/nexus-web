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
the runtime's own `retry()`. no durable recovery was added.

remaining gaps:
- copying retained input is not offered: the runtime exposes no accessor for
  uncommitted text once its editors unmount, and adding one is new runtime scope.
- the outer boundaries render outside the account provider, so they guard exit and
  reload but cannot address the account runtime for retry.
- `WorkProvider`'s own exit risk still ignores `hasUncommittedWriting()`, so closing an
  editor pane after a failed local save relies on that editor's own registration.

resolved when a real failed local save followed by a render failure still guards
browser reload and native exit and permits retry (or copy) of the retained input.
