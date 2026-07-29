# Machine Hand Hard Cutover

**Status:** IMPLEMENTED · **Chat presentation authority:**
`docs/cutovers/chat-interface-hard-cutover.md`

## Decision

Machine-authored artifacts use one honest typographic register: machine face,
cooler ink, optional hairline rail, and an origin signature. `MachineText` is
the sole owner of that register.

Conversational assistant answers are excluded. Chat is a sustained reading
surface and uses the normal sans register. Provenance remains available in its
closed Details disclosure.

## Scope

Machine Hand applies to authored artifacts and compact machine rationales,
including:

- Dossier surfaces and media abstracts;
- Synapse/connection rationales;
- Dawn writes;
- reader evidence/margin annotations whose owning surface records machine
  provenance;
- the Docent citing-sentence caption.

It does not apply to:

- user or assistant chat prose;
- chat Sources, Details, write trail, or controls;
- Oracle's manuscript persona;
- human notes, highlights, prompts, or controls.

## Ownership

| Capability | Owner |
| --- | --- |
| Machine register component | `components/ui/MachineText.tsx` |
| Machine register CSS | `components/ui/MachineText.module.css` |
| Sandboxed Dossier document stylesheet | `machineDocumentStyles(theme)` in `components/ui/MachineText.tsx` |
| Font/ink/rail tokens | `app/globals.css` |
| Token and consumer guards | `lib/ui/machineHandCutover.guards.test.ts` |

No consumer references `--font-machine`, `--ink-machine`, or `--rail-machine`
directly.

`machineDocumentStyles("light" | "dark")` is the sealed iframe exception. It
returns only fixed, pre-authored, theme-aware Dossier article CSS; it accepts no
model/document value and is consumed only by `DossierDocumentFrame`. The outer
`DossierSurface` retains the `MachineText` origin/signature. The model supplies
semantic article structure only and cannot supply style, color, typography, or
document chrome.

## Component contract

```ts
interface MachineOrigin {
  label: string;
}

type MachineSignatureTime =
  | { timestamp: string; timestampIso: string }
  | { timestamp?: null; timestampIso?: null };

type MachineTextProps = HTMLAttributes<HTMLElement> & {
  origin: MachineOrigin;
  variant?: "block" | "inline";
  showSignature?: boolean;
  as?: "div" | "section" | "span";
} & MachineSignatureTime;
```

Rules:

- `origin.label` derives from the surface's real provenance.
- Block mode may render the origin signature and optional valid `<time>`.
- Inline mode renders neither rail nor signature.
- Timestamp display and ISO instant travel together or not at all.
- Machine prose/content sits inside `MachineText`; interactive surface chrome
  remains in the normal sans register.
- `...rest`, class names, data attributes, and event handlers pass through.

## Chat exclusion

`AssistantMessage` does not import or render `MachineText`. Its answer is
rendered by `AssistantAnswer` through `MarkdownMessage` in the normal chat prose
register. The visible `Assistant` signature and machine rail are deleted.

This exclusion does not weaken token ownership or non-chat consumer guards.
`MarkdownMessage` is a shared renderer; whether it sits inside `MachineText` is
decided by the owning surface, not by a global importer closed set.

## Accessibility and layout

- Signatures are text, not color-only provenance.
- Block rail and ink meet the repository contrast contract.
- A nested control cannot inherit the machine font.
- Logical sizing and wrapping prevent machine content from widening its pane.
- Reduced-motion preferences apply to consumer motion; `MachineText` adds none.

## Hard-cut deletions

- The rule that all `MarkdownMessage` consumers require a `MachineText`
  ancestor is deleted.
- The closed set of Markdown importers is deleted.
- Chat-specific assistant signature, time formatting, wrapper placement, and
  guard clauses are deleted.
- No chat compatibility wrapper, `showSignature={false}` substitute, or direct
  token use remains.

## Acceptance

1. `MachineText.module.css` is the only module CSS that references the three
   machine tokens.
2. Production TSX contains no inline machine-token bypass.
3. Every retained machine artifact derives and stamps its honest origin.
4. Oracle imports no `MachineText`.
5. `AssistantMessage` imports no `MachineText` and renders no machine origin
   signature.
6. Block/inline, signature, timestamp-pair, rest-prop, and control-font behavior
   pass focused component tests.
7. Chat answer readability and containment pass the chat-interface acceptance
   suite.
8. `DossierDocumentFrame` consumes the sealed document stylesheet, runs with
   sandbox exactly `allow-scripts`, and keeps the origin signature outside the
   frame.

## Verification

- `MachineText.test.tsx`
- `machineHandCutover.guards.test.ts`
- focused tests for the retained Dossier, Synapse, Dawn, reader, and Docent
  consumers when those files change;
- `AssistantMessage.test.tsx` for the explicit chat exclusion.

No broad suite is required for this presentation-only hard cut.
