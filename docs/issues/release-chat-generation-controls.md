# release chat generation controls

pair api, web and android at wire 17. the live `/version` read during this change
returned `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`, whose api wire revision is 16;
main already carries the unreleased wire-17 break. this cut therefore rides 17.

the catalog replaces its unused reasoning label/source-default fields with
required product default and atomic label fields. deploy the matching generated
web wire and native interface together; no compatibility reader remains.
migration 0325, after 0324, creates `chat_selections` without backfill. existing
accounts start with no remembered choice until their next accepted generation.
downgrade discards only selection memory. use the ordinary stopped-writer,
backup and exact-head release procedure. account credentials remain unchanged;
the paired [catalog cutover](release-model-catalog.md) owns provider-host pins.

production activation remains outside this implementation. resolved when the
paired deployed artifacts expose the new catalog and `/me/chat-selection`,
provider/model changes choose the declared defaults, and accepted choices survive
reload on each paired client. validate unavailable choices and recall recovery.
