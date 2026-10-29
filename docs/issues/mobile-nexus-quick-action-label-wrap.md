# mobile nexus quick-action label breaks within a word

at 320px with normal text, the overview's import command renders as `impor` /
`t`. the action remains reachable, but a short utility label becomes harder to
scan. this belongs to the overview action layout, outside the header-icon cut.

evidence: disposable run `20261028-172107-ee2d53d2c712`, screenshot
`overview-320-focus.png`. `apps/web/src/components/nexus/Nexus.module.css:485-486`
uses 5.5rem minimum quick-action columns with inline padding/icon gaps;
`:88` allows word-internal wrapping. these rules are unchanged by the icon work.
the split also appears on unchanged source `492d01595` in baseline run
`20261028-171040-97461ffe38db`'s presentation-failure screenshot.

resolve by fitting the existing labeled actions at their layout owner while
preserving usable targets. verify normal 320px layout and enlarged text: short
labels remain whole, actions remain visible, and no target shrinks to fit.
