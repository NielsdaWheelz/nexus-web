# resource resolution escapes the pane boundary

- status: open
- origin: 2026-09-13 second-tab crash investigation; sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: workspace resource resolution and failure containment

`apps/web/src/lib/panes/usePaneResourceResolutionRegistry.ts:114` stores any
decoder, same-system api, or non-api failure in one global defect latch; line
197 throws it during the registry owner's render. `apps/web/src/components/workspace/WorkspaceHost.tsx:773`
calls that hook above every pane error boundary (line 1558). one resource
failure therefore escapes all pane boundaries and can replace the whole
workspace. the documented promise in `docs/modules/workspace.md` is that one
pane failure cannot replace its siblings. this is a confirmed containment gap,
not a reproduced explanation of the reported crash.

the deployed sha `7e8fd48244b3b436965037738e05785bb4931be1` does not contain
this registry; its older inline resource-resolution effect has a different
error path. this ticket concerns the current checkout, not that deployment.

prerequisites: preserve strict transport decoding and identify the smallest
resource request whose failure is known. no malformed value may become a
successful or retryable operational result.

proposed fix: retain a defect per live resource request/locator and throw its
original cause from a component inside the affected pane boundary. fence late
failures by the same request identity as successful results; retire them when
the locator leaves. keep workspace-global invariant failures global.

acceptance: opening a malformed-resource pane preserves a healthy sibling and
workspace navigation on desktop and mobile; a delayed failure from a closed
pane affects neither a replacement nor a sibling; the original defect reaches
telemetry. demonstrate regression sensitivity through `./scripts/test`.
