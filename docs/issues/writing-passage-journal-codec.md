# current passage writing appears as incompatible recovery

lab8 `writing-owner-discard.spec.ts:250` creates a passage through a real pointer
selection, completes a rich checkpoint and opens notes recovery. the normal
discard does not remove the row; the snapshot also presents its prose under
`discard old-version writing`. failure: line 190 expects the old row absent.

evidence: `.nexus-local/lab/20261021-143343-814cc778461b/artifacts/playwright-targets/`
`writing-owner-discard-reta-72527-ew-input-without-submission/{trace.zip,error-context.md}`.
the stored `context.passage` includes transient selection-event `kind` and `input`
fields. `useSelectionComposer.ts:130` passes `entry.passage` directly;
`journal.ts:502` correctly requires only `identity`, `quote` and `anchor`.
project those three durable fields at the producer; keep the closed decoder.
prove ordinary passage checkpoints decode, discard renews the retained owner,
and offline passage recovery retains its explicit-save policy and rich content.
