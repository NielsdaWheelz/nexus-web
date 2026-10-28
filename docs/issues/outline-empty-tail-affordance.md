# tail hint accessibility remains unobserved

the original blank tail lacked a discoverable entry. that visual defect is
repaired: `apps/web/src/lib/notes/outlineController.ts` sets the tail field's
`data-empty` and placeholder from its current node; the existing editor
placeholder grid supplies the hint without adding authored text.

the focused first-note case blocks the real creation command and checks that
first character, clipboard, canonical writing, host and next tail. it passed on
`f07f1963eb`, canonical run `20261026-000347-391b5f12f965`, including actual
emulated-touch input and the 44px target. receipt metadata does not cover the
first character with a stale hint. this is not an unresolved missing-placeholder
defect.

screen-reader navigation/announcement and hint appearance during a physical
composition cycle remain unobserved. the latter also needs the
[physical ime prerequisite](local-first-physical-ime-composition.md).
resolve with actual assistive-technology navigation into the writing entry and,
when supported physical input emits composition, correct hint removal without
changing copied writing, caret or host ownership. source pseudo-content and
browser touch controls do not substitute for those observations.
