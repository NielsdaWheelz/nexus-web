# reader chat opening always forks

problem: an ordinary open-chat action creates another pane instead of following
or focusing the selected conversation.

evidence at `4d4a32816`, under `apps/web/src/`:

- `app/(authenticated)/media/[id]/useSelectionComposer.ts:824-827` hardcodes
  `Fork` in `openChat()`. send/retry handoff supplies the same disposition.
- `lib/panes/openResult.ts:118-126` applies the original handoff disposition
  to a late ready-offer's fresh link activation.

these navigation semantics are outside the compact-composer change. pass fresh
opening intent through ordinary open actions; keep send admission and automatic
handoff as separate contracts.

resolved when ordinary open follows/reuses and shifted open creates one fresh
pane, preserving the chosen conversation endpoint and unsubmitted passage input.
