# qualify transformed modal placement

constrained modal slips borrow a content rectangle, but its current geometry removes the panel transform. a moving sheet's fixed header can therefore cross that stationary rectangle. this is a source-identified placement hazard; no motion collision was observed in the current headless cases.

at product head `9f0649d0eafae398a46f9ab574eb81a77acad27c`, `apps/web/src/components/feedback/Slips.tsx:143` measures final layout through `panel.offsetTop`, and line176 subtracts the moving panel's rectangle from the content rectangle. `components/ui/MobileSheet.tsx:68` translates that panel during a drag; its css line43 also animates the panel's entrance. resize observers do not report position-only transforms. outside-above placement remains clear during downward motion; the constrained content case needs separate qualification.

reproduce with real words at risk in a short typed phone nexus, then drag its handle downward while holding the gesture. sample the frame, restore control and fixed handle/actions throughout the drag and entrance. resolve by proving every painted/hit rectangle stays clear, or by tracking the family's finite motion through its explicit panel/content contract. preserve semantic containment, actionable risk and no feedback-owned panel space. physical keyboard/safe-area qualification remains separate.
