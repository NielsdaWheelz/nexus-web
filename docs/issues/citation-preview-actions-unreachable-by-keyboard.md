# the citation preview's actions are unreachable by keyboard

status: open · origin: 2026-10-10 overlay kernel reauthor (cleanup/overlay-kernel-reauthor) · area: web / chat, overlays

the desktop citation card (`useHoverPreview`, `apps/web/src/components/ui/HoverPreview.tsx`)
is `role="tooltip"` but holds a button (Open in context or Open source,
`components/ui/ReaderCitation.tsx`; the never-produced Copy citation went with
the visual primitives reauthor). it renders at the end of the body (or of
the containing modal's panel), so Tab from the citation goes to the next
focusable element in the answer, not into the card, and focus moving away
closes it. keyboard focus opens the card and Escape closes it; its action is
pointer-only.

impact: keyboard and screen-reader users get the preview text but not its
action (the citation itself still opens the source).

what to do: make the card a non-modal dialog that a key on the focused
citation moves focus into (and back out of), or render the actions in dom
order after the citation; drop `role="tooltip"` either way.

resolved when: a keyboard-only harness journey opens the card from a citation,
reaches its action, uses it and returns to the citation.
