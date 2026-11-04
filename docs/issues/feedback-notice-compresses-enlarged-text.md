# feedback notices compress enlarged text into fragments

status: open
origin: 2026-10-15 pane-query native text-zoom qualification
area: shared feedback / accessibility

at a 320px pane and actual firefox 158 text-only zoom of 200%, the podcast
invalid-order notice breaks ordinary words into fragments and its reset action
falls below the visible body. the toolbar's selected `Unsupported order` stays
readable. #628 committed a screenshot of it.

reproduce: open `/podcasts?sort=unsupported`, reduce the pane to 320px, and use
firefox's actual text-only zoom at 200%. inspect the failure fact and recovery
action. the cited three-track `Feedback.module.css` composition is retired;
current in-flow facts belong to `components/feedback/Fact.tsx` and
`Fact.module.css`. this historical screenshot does not establish the same fault
in that composition. paths are under `apps/web/src/`.

prerequisite: repeat the original actual text-zoom check against the current
fact; a narrow viewport alone does not exercise enlarged text. if it fails,
repair the owning composition while preserving speech and action contracts.
acceptance: failure copy remains readable without mid-word fragmentation, and
recovery actions remain reachable at the same pane/text settings.
