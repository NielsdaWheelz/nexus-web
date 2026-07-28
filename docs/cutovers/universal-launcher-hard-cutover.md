# Universal Launcher — Desktop Contract

**Status:** Implemented · **Rev 3** · 2026-07-27

**Type:** Hard cutover — no palette-era aliases, fallback path, compatibility
shim, dual entry point, or old behavior flag.

The current mobile contract is
[`mobile-nexus-switchboard-hard-cutover.md`](mobile-nexus-switchboard-hard-cutover.md).
Mobile has no Launcher palette, lane chips, navigation drawer, or separate Add
control. This document owns the desktop Launcher only, plus shared capability
owners used by both projections.

## One-line

Desktop keeps one keyboard-first Launcher for commands, retrieval, external
discovery, and embedded Add/Today workflows; mobile projects the same lower
capabilities through the intent-specific Nexus Switchboard.

## Desktop behavior

- `Cmd/Ctrl-K` and the rail command control open Launcher Root.
- The desktop rail `+` opens the source-first Add workbench directly.
- Root keeps the current blended ranking, lane chips, sigils, keyboard
  navigation, history boost, and contextual Add rows.
- The create projection contains Chat, Page, and Note only. Its behavior derives
  from the shared quick-action registry; Library and Podcast are not
  desktop-root commands.
- Search and Browse continue to use their canonical domain clients and may link
  to dense route-owned surfaces.
- Add and Today Capture render inside the desktop Launcher surface. Their
  sessions are shell-owned so a breakpoint change does not reset work.
- External results keep their explicit Follow/acquire behavior. The mobile
  Switchboard's route-only Find/Adopt policy does not broaden desktop behavior.

## Shared architecture

`Launcher` is the shell-mounted cross-form-factor owner:

```text
Launcher
├── useLauncherController
│   ├── open event + keybinding
│   ├── exhaustive workflow/page state
│   ├── Add and Today Capture sessions
│   ├── domain mutation calls
│   └── target dispatch + pane-cap recovery
├── desktop → LauncherSurface + desktop provider/ranking projection
└── mobile  → SwitchboardSheet + Switchboard presentation controller
```

The shell, not either presentation, owns workflow state and mutation lifecycle.
Only the active viewport projection fetches. Breakpoint changes preserve the
page, query/draft, replay identity, retained activation, session state, and
focus contract.

## Capability owners

| Concern | Owner |
| --- | --- |
| Input parsing and desktop lanes | `apps/web/src/lib/launcher/parseLauncherInput.ts`, `model.ts` |
| Desktop providers and ranking | `apps/web/src/lib/launcher/providers.ts`, `ranking.ts` |
| Shared Quick semantics | `apps/web/src/lib/launcher/quickActions.ts` |
| Workflow/session controller | `apps/web/src/components/launcher/useLauncherController.ts` |
| Add session | `apps/web/src/components/launcher/useAddContentSession.ts` |
| Today Capture session | `apps/web/src/components/launcher/TodayCapturePanel.tsx` and its lifted session owner |
| Desktop presentation | `apps/web/src/components/launcher/LauncherSurface.tsx` |
| Mobile presentation | `apps/web/src/components/switchboard/*` |
| Domain target dispatch | `apps/web/src/lib/launcher/dispatch.ts` |
| Destination identity | `apps/web/src/lib/navigation/destinations.ts` |
| Search query model | `apps/web/src/lib/search/*` |
| Workspace activation | `activateWorkspaceTarget` in `apps/web/src/lib/workspace/store.tsx` |

Components do not call pane creation, domain mutations, `window.location`, or
resource activation directly. The controller calls domain clients and sends
typed targets through the one dispatch/workspace activation seam.

## Shared workflow state

The exhaustive shell page union contains Root, Find, Actions, Today Capture,
Page creation, Library creation, Add, Podcast discovery, activation recovery,
and tab management. Desktop Root projects only its existing discoverable
commands, but it can render any workflow carried across a breakpoint.

A domain mutation that commits before pane activation is never repeated.
Pane-cap rejection retains the canonical target in shell state. Manage tabs
changes panes; Open retries activation only; explicit Cancel or successful
activation clears the target.

Page and Library submits keep one client-minted resource UUID for the complete
logical submit. Add, Today Capture, OPML, and podcast subscription retain their
domain replay identities for the lifetime of the shell session.

## Mobile hard cut

The mobile projection is owned exclusively by the Switchboard spec:

- one bottom Nexus trigger with the exact open-pane count;
- one mounted `MobileSheet`;
- Root, Find, Quick, Places, open panes, and recently closed;
- no mobile Launcher lanes, blended provider rows, or app-navigation drawer;
- no separate mobile command, Add, Home, or tab-count control;
- route-only owned-resource Find with `Adopt`, and explicit `Fork`;
- shell-owned recovery after pane-cap rejection.

## Final files

Retain:

- `components/launcher/{Launcher,LauncherSurface,LauncherInput,LauncherList,LauncherRow,AddPanel,TodayCapturePanel}.tsx`
- `components/launcher/useLauncherController.ts`
- `lib/launcher/{model,parseLauncherInput,providers,ranking,actions,dispatch,launcherEvents,quickActions}.ts`
- `lib/navigation/destinations.ts`
- `lib/api/useDebouncedFetch.ts`

Mobile-only Launcher presentation and palette-era aliases are deleted. The only
mobile global-access files live under `components/switchboard/` and
`lib/switchboard/`.

## Verification

- Desktop component tests cover the keybinding, lanes, ranking, Add, Today
  Capture, actions, and focus behavior.
- Cross-viewport tests prove every shell page/session/replay/retained-target
  transition without reinitialization.
- Static gates find no palette-era names or mobile Launcher presentation.
- Switchboard and workspace tests own all mobile behavior; see the mobile
  cutover's acceptance criteria and verification matrix.
