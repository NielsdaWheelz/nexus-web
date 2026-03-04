# PR-03 Hardening: Shared Surface Chrome + E2E Stability

## Scope

This pass hardens the shared header migration (`SurfaceHeader`) across media, libraries, and conversations, and closes test gaps discovered during senior review.

## Key hardening changes

1. **Options menu accessibility and keyboard semantics**
   - first enabled menu item receives focus on open
   - `Tab`/`Shift+Tab` loop focus within the open menu
   - `ArrowUp`/`ArrowDown`, `Home`, and `End` support menu navigation
   - `Escape` closes menu and restores focus to the trigger
   - disabled link options are non-interactive (`aria-disabled`, `tabIndex=-1`, click/key prevention)

2. **Back control safety**
   - `SurfaceHeader` no longer renders an inert back button when neither `href` nor `onClick` is provided.

3. **PDF control parity in shared chrome**
   - `PdfReader` external controls API now exposes:
     - navigation + zoom actions
     - selection snapshot + highlight creation actions
     - highlight telemetry/state for deterministic UI instrumentation
   - media header now renders the highlight action in shared chrome with telemetry attributes used by E2E checks.

4. **Pane resize accessibility**
   - resize handle now supports keyboard resizing (`ArrowLeft`, `ArrowRight`, `Home`, `End`)
   - handle is focusable and labeled as a vertical separator.

5. **Route-level E2E coverage**
   - added `e2e/tests/pane-chrome.spec.ts` to validate:
     - non-scroll-coupled back controls in media/library detail panes
     - nav control visibility by media kind (PDF vs EPUB vs transcript)

6. **E2E reliability updates**
   - `pdf-reader.spec.ts` made robust to shared-run interference:
     - page indicator locator updated for shared-header rendering
     - upload flow persistence assertion now verifies by created highlight id in linked-items scope
     - suite runs serially to avoid cross-test highlight collisions in shared seeded media
   - `epub.spec.ts` alignment thresholds updated to reflect the new shared-header layout baseline while preserving intent.

## Validation run

- targeted component tests:
  - `cd apps/web && npm run test -- src/__tests__/components/SurfaceHeader.test.tsx src/__tests__/components/Pane.test.tsx src/__tests__/components/PdfReader.test.tsx src/__tests__/components/PageLayout.test.tsx`
- targeted e2e:
  - `cd e2e && CI= PORT=3311 WEB_PORT=3311 API_PORT=8311 npx playwright test tests/pane-chrome.spec.ts --project=chromium`
  - `cd e2e && CI= PORT=3312 WEB_PORT=3312 API_PORT=8312 npx playwright test tests/pdf-reader.spec.ts --project=chromium`
  - `cd e2e && CI= PORT=3313 WEB_PORT=3313 API_PORT=8313 npx playwright test tests/epub.spec.ts --project=chromium`
- full gates:
  - `make verify` (pass)
  - `make e2e` (pass)
