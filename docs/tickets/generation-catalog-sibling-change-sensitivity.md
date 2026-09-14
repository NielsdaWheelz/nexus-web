# generation catalog sibling change has no behavioral red owner

- status: open
- origin: 2026-09-14, pr #246, ci run `34830838238`
- area: proof ownership

`c017923905316514/summary.json` selects
`test_generation_catalog.py::test_complete_catalog_and_selection_contract`
for base sensitivity. only its sibling
`test_source_controlled_receipts_fail_closed_on_source_drift` changed.
the canonical owner's digest is identical at candidate and base
`7a646cf5a5a79fe7ad7049c1a09f2cfdec18fe78`:
`efc93fb35109b850d86d5fd44c74cea87d70aeff780bfafb20b3715d9f711b46`.
it has no declared product fault. `workflow_sensitivity_request` in
`python/nexus_test_control/sensitivity.py:520` therefore selects the base
despite unchanged exact ownership. the migration failure stopped this ci run
before that red executed.

first run the exact canonical proof against that base. if it remains green,
give the retained catalog behavior an independently reviewed behavioral fault
or correct its canonical proof ownership. preserve the complete catalog oracle;
do not weaken it or add an existence assertion.

acceptance: the default pr selection demonstrates behavioral red and green
for the retained catalog contract without widening the proof framework.
