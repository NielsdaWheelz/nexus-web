# deferred reader navigation and note proposals

status: implementation in progress for the 57-item follow-up; 168 prior repairs accepted
origin: 2026-09-27 pr #398 acceptance; 2026-10-14 r3 disposition
area: reader / source proposals

this change's pr holds the57-repair plan and owner decisions. all57 complete
candidate projections have source approval on
`ebdcda1a13c274b44ba5de861b89285005f5ef53`. all57 clone applies, fresh inspection,
no-op and global preservation checks pass. deployment and live acceptance remain
pending. inventory is unchanged. authoritative private status:
`progress.json:followup57`; content approval: `coordinator/followup57-20261016/source-approval-ebdcda1a1.json`.

problem and impact: 57 historically rejected proposals need source-verified
replacements: 40 navigation, 14 note-content/link and three navigation-source
selection cases. production metadata remains unrepaired. source approval alone
does not resolve them. corrections use shared causes, not book-specific patches.

the frozen 499 ids reconcile to 168 repaired, 265 unchanged, 57 unsafe,
five source-unproved and four deleted. source-unproved and deleted dispositions
do not authorize reconstruction or expand this campaign. the
[plan](../book-repair-plan.md) owns scope and acceptance.

accepted boundary: all 168 source-approved applies are verified on pinned
`f4026846f857fd137e9c9e170faba05f07c5e282`, schema0287. final root
`coordinator/finalf4026846/reader-final-acceptance.json`, sha256
`9915b658125405cc47a1257d3209d2ac86e61bdc4fdea707fa79bffd0ece72bc`,
binds complete source, persisted-projection and protected-state proofs:
166 complete http projections and two preserved expected access refusals for
owned, unfiled publications. no rendered consumer is claimed for those two.
the separate phone focus correction is also live-accepted (`0a2e66cb` in the
plan); it required no further reader apply. original failures,
reconciliations and continuations remain immutable in private campaign receipts.

prerequisites for future repair: prove the retained source and complete proposed
diff, including publisher hierarchy, reading extents, note bodies/links and
historical apparatus identities. retain unchanged proposals when assessing a
shared-cause correction; successful parsing alone never authorizes a repair.
use the existing fenced planner/publication owner, protected-state proof,
verified backup and affected-copy procedure.

acceptance: each of the 57 ids receives a corrected, independently source-verified
repair with exact persisted/protected and affected-consumer proof, or a
source-proved no-change outcome. retain unresolved cases and their evidence;
a passing aggregate or current campaign closure is insufficient.

exact deferred inventory (source/proposal hashes and source reviews remain in
these immutable ledgers; no private text is copied here):

- `a-maintenance/navigation61-disposition-ledger-v15.json` / `21ecc6e33ce8cb5903568e56ef9ad8bf9c99fad819a776b861bb121b4667384c`.
- `b-reader/partition-b34-content-dispositions-v10.json` / `630b793810c3aa4a40d92debac5b0b22d18caae7a09560ffa6f6cd4faae07623`.
- `c-sources/content-status-v20.json` / `c6600cc1166c6af7d201afe812fd743647a945f39e9cdf56f01eecf281d5b642`.

navigation: publisher hierarchy/reading-boundary and landmark preservation;
reuse the existing cause tickets under `epub-*`, rather than one patch per id.

`02b3b38c-ed34-4a34-83b0-bce8f8850e75`, `09f34c39-5c2c-481a-a713-9d83f7bbf320`, `15d9b33d-f13c-4542-969c-2ab74d5c3659`, `1c6951c9-b84c-43c9-b952-809316f0df76`, `211dd5d1-1d8f-43f8-b48c-92fb089a8671`, `2baa6224-e88b-4c25-a416-074064cde3d2`, `2c4eb378-a571-4cae-a9f0-cdfaea9768f5`, `2ce4bf54-f9dd-472e-8005-e8a9582f212d`, `3104a096-5ed6-4cc3-a02f-dd04acfc033d`, `39121faf-e147-4f49-9edc-e70c8a832a4b`, `3b353574-730a-4a18-be83-55ff894058bf`, `3d8664d1-2d8d-451f-be13-b689ce94c664`, `44c980bd-ff3c-47c4-8674-df42a9694423`, `59584b41-bee7-4722-9c42-04abad92679d`, `66798f2d-60d7-4ece-821f-bc0c52b7c866`, `749e5383-1883-4f9d-8f0c-9508fa9adcd9`, `77e01dd8-264b-4169-9a53-e317b1219709`, `781fc83c-3804-4611-9a7a-b475dbacebdf`, `868bf466-0862-4770-a46b-bd398a23a718`, `895cc902-b1b6-4e69-93ca-30fff2ace5b6`, `898b1816-2b0e-4e85-9027-9c629be025d5`, `9edf7d20-68e3-406c-8af3-6b9f1056b262`, `a0b16180-2833-4854-8ceb-d3763884e096`, `a19df1fb-4675-46a7-9b6c-b551a3dabce9`, `a29b4729-d99b-4a97-afa1-f9f188beae3e`, `a48ee710-ceb9-4428-a67e-da5e7870d634`, `a632754f-6646-4a8f-a36c-0c5ba3decc00`, `b09352f1-a394-46ba-a6b4-3e7a546fb291`, `bf8ccea7-e2e8-4eea-bc2f-188874677302`, `bfbce747-c3be-4652-b9e3-722dc04d13a2`, `c1260306-6a98-4282-b6c7-c682913beb90`, `c5caf377-cbf0-43e1-8aee-906e338d6f90`, `ce72f700-7416-44a5-ac80-9a2fb8d23717`, `cf26ed31-1cf3-433f-b310-ee923e197652`, `dffd5b19-d5c0-4768-80ff-266b7797d596`, `e838122f-a37f-40bd-90b1-2d1b5bd610cc`, `ee255f6b-aecb-408a-97c1-2fee04ca4b08`, `eef19922-06e4-4d10-bd49-2445057bf4c1`, `f0c3a6f6-e336-4ff8-bd0f-2dbb90d4a32b`, `fbc9bf7f-b48a-4b53-b14e-e6fff10f1934`.

note-content/link: continuation materialization, paragraph attribution, rich
body preservation and backlink orientation. existing shared-cause tickets
remain open.

`11980da0-9758-40ab-902e-4bd1ea0b77e7`, `20405d0e-4fda-4cc7-b5e0-04b6a8a724d6`, `228d14cf-120c-495c-9e5c-5a3383658843`, `24e67f54-353e-4791-8db5-72c935a4bf9c`, `260d82bd-251c-404c-ba1d-3cb30a65232c`, `44218cdb-014a-44ec-aaf2-300dbb2a4773`, `6a7716ee-32f2-4d5c-bda0-ae56b05838b6`, `6fc37025-9aab-4a0f-aa0c-b94db2437e9c`, `7db2fb1e-cbb1-415a-b994-0963866ec1c9`, `b13e55e0-03d0-4212-a6f7-eaee1f306fbc`, `ccba64e7-8e7b-4afb-a1d3-f7e498a637e3`, `d580cfca-da7e-4a2c-b011-754a7c4df040`, `dc0c28e2-8263-4bdd-8ef6-dcfd6781051c`, `e6b755eb-c744-4391-b6ec-2b3ed2553837`.

navigation-source selection: `748f7d1c-05dc-4937-b604-695b98f6a9a4`,
`afec0538-875f-4709-b168-20e25f244820`,
`eaccf598-d00e-424d-a666-c20c777aae9c`;
[existing source-owner ticket](reader-repair-epub3-missing-nav.md).
