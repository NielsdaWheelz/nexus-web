# Superseded Workspace Layout Note

This document is historical. The current workspace pane sizing and attached
secondary pane contract is `docs/workspace-pane-system-consolidation-cutover.md`.

Current layout rules:

- Primary width, fixed primary chrome width, and visible attached secondary width
  are independent inputs to one compound pane width.
- Primary resize writes only primary width.
- Secondary resize writes only the attached secondary width.
- Fixed primary chrome is runtime-published and not persisted.
- Mobile secondary surfaces are modal sheets and add no width.
- Workspace layout never travels in the URL.
