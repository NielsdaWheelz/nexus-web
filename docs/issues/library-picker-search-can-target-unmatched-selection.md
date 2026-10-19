# library search can target an unrelated selected destination

status: open · origin: 2026-10-14 library picker design audit · area: web / libraries

problem: selected destinations stay in the navigable results regardless of the query. the active row can therefore name a library unrelated to the text the user just entered, and enter can remove that membership.

evidence: `apps/web/src/components/libraries/LibraryDestinationPicker.tsx:176-179` prepends all selected destinations; `LibraryEntryEditor.tsx:118-127` does the same for existing placements. `LibraryChooser.tsx:93-113` puts these rows first and preserves their active identity across query changes. source trace only; no live mutation performed.

reproduce: select library a, leave it active, search for differently named library b, and press enter. a remains eligible for activation despite not matching the query.

prerequisites: define one query-to-result and active-option contract for draft destinations and existing placements.

the extension shares the same behavior: `apps/web/src/extension/popup.tsx:338-380` prepends unfiltered selected destinations to the shared chooser. include that adapter in the contract change.

fix: apply the query to every candidate, selected or not; preserve membership in row state or a separate summary. reset navigation on query changes, and preserve identity only within the same valid result context.

acceptance: a nonmatching selected library never becomes a search result or enter target; searching for an existing membership still offers its explicit removal.
