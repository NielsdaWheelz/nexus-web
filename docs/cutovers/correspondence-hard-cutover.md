# Correspondence Hard Cutover

**Status:** IMPLEMENTED · **Presentation authority:**
`docs/cutovers/chat-interface-hard-cutover.md`

## Decision

Chat is a flat editorial exchange rather than a stack of speech bubbles.
This cutover owns the retained correspondence substrate:

- full-measure user inquiries with a quiet accent rail;
- flat composer geometry;
- superscript inline citation markers;
- backend run usage and cost facts on the trust trail.

The chat-interface cutover owns the final transcript hierarchy, typography,
disclosures, and responsive behavior.

## Final state

### User inquiry

- No bubble, avatar, or visible role heading.
- Normal sans reading text.
- Quiet inline-start accent rail.
- One hover/focus timestamp, visible on non-hover devices.
- Programmatic role identity and the accessible label `Your message`.

### Assistant answer

- Normal sans reading text; chat does not compose `MachineText`.
- Inline citations remain superscript links/buttons at the cited claim.
- `MessageSourcesDisclosure` owns the numbered `Sources (N)` apparatus and is
  closed by default.
- `AssistantDetails` owns model, usage, cost, tool/retrieval, context-reference,
  and integrity diagnostics and is closed by default.
- `AssistantWriteTrail` remains visible because completed writes and Undo are
  immediately actionable.
- No colophon exists. Its model/token/cost/source line duplicated Details and
  permanently displaced the answer.

### Composer

- One flat writing surface.
- Profile/reasoning controls and send/stop actions remain in the action row.
- Normal send-capability state consumes no visible error space.
- Actual send errors and reconciliation remain visible.

## Ownership

| Capability | Owner |
| --- | --- |
| Turn composition | `components/chat/MessageRow.tsx` |
| User inquiry | `components/chat/UserMessage.tsx` |
| Assistant answer | `components/chat/AssistantAnswer.tsx` |
| Inline citation | `components/reader/ReaderCitation.tsx` |
| Source apparatus | `components/chat/MessageSourcesDisclosure.tsx` |
| Run diagnostics | `components/chat/AssistantDetails.tsx` |
| Consequential write trail | `components/chat/AssistantWriteTrail.tsx` |
| Run usage/cost data | `TrustRunOut` in the assistant trust trail |

## Data contract

Correspondence adds no message-level provenance object. Model, token usage, and
`total_cost_usd_micros` stay on the persisted run projection inside
`message.trust_trail.run`. Sources remain derived from citation edges. The
frontend does not duplicate either fact.

## Hard-cut deletions

- `MessageFootnotes` is replaced by `MessageSourcesDisclosure`.
- `AssistantEvidenceDisclosure` is replaced by `AssistantAnswer`.
- `AssistantTrustInspector` is replaced by `AssistantDetails`, with the write
  trail split to its own owner.
- `Colophon` and its formatting helpers, CSS, and tests are deleted.
- Chat's `MachineText` wrapper and visible `Assistant` signature are deleted.
- The visible `You` kicker is deleted.
- No alias, re-export, deprecated prop, or compatibility CSS selector remains.

## Acceptance

1. User and assistant prose share the readable chat measure and normal sans
   register without visible role headings.
2. Inline citation activation is unchanged.
3. `Sources (N)` and `Details` are native, closed disclosures.
4. Model, token, cost, and source facts have one display home.
5. Writes and Undo remain visible; read-only diagnostics are opt-in.
6. The composer presents routine capability state without error chrome.
7. Deleted component names have no production or test import.

## Verification

- `MessageRow.test.tsx`
- `AssistantMessage.test.tsx`
- `MessageSourcesDisclosure.test.tsx`
- `ReaderCitation.test.tsx`
- `ChatComposer.test.tsx`
- `machineHandCutover.guards.test.ts`

The implementation and final acceptance matrix live in
`docs/cutovers/chat-interface-hard-cutover.md`.
