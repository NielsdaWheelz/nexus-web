# release chat generation controls

pair api, web and android at wire 17. the live `/version` read during this change
returned `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`, whose api wire revision is 16;
main already carries the unreleased wire-17 break. this cut therefore rides 17.

the catalog replaces its unused reasoning label/source-default fields with
required product default and atomic label fields. deploy the matching generated
web wire and native interface together; no compatibility reader remains. there
is no database migration, credential change or provider-host upgrade for this cut.

production activation remains outside this implementation. resolved when the
paired deployed artifacts expose the new catalog, provider/model changes choose
the declared defaults, and new runs preserve the shown exact choice. validate
existing unavailable selections and the cold-load recovery action after pairing.
