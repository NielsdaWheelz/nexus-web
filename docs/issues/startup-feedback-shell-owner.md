# startup transport feedback needs a shell owner at the cut

`BrowserWorkspace` calls `useTransportVerbs` before it mounts the authenticated shell. its local startup sign-in remains valid, but retry/update projection currently reads the feedback shell context's default.

impact: deleting that default in L7 without migrating this startup owner would break cold-open failure rendering. this is a cut prerequisite, not an observed current startup failure.

evidence: `apps/web/src/lib/authored/BrowserWorkspace.tsx:32,130`; `apps/web/src/components/feedback/stage.ts:459`; `apps/web/src/components/feedback/Feedback.tsx:226`. the authenticated FeedbackProvider first mounts in `AuthenticatedShell.tsx:91`.

resolved when startup has an explicit canonical transport owner independent of the removed default, and cold sign-in/update/retry failure journeys pass after the default is removed. preserve startup's real sign-in responsibility; do not substitute the later account's unmounted callback.
