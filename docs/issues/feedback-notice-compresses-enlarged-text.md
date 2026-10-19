# feedback notices compress enlarged text into fragments

status: open
origin: 2026-10-15 pane-query native text-zoom qualification
area: shared feedback / accessibility

at a 320px pane and actual firefox 158 text-only zoom of 200%, the podcast
invalid-order notice breaks ordinary words into fragments and its reset action
falls below the visible body. the toolbar's selected `Unsupported order` stays
readable. #628 committed a screenshot of it.

reproduce: open `/podcasts?sort=unsupported`, reduce the pane to 320px, and use
firefox's actual text-only zoom at 200%. inspect the failure notice and recovery
action. `components/feedback/Feedback.module.css:54,78,97` retains three grid
tracks, rem padding and a 3rem tone marker; the copy column has little space.
paths are under `apps/web/src/`; this owner is unchanged by the toolbar cutover.

prerequisite: agree the shared notice's narrow/enlarged composition. reflow the
notice at its owner, preserving its announcement and action contracts.
acceptance: failure copy remains readable without mid-word fragmentation, and
recovery actions remain reachable at the same pane/text settings.
