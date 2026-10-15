# x titles misattribute the lord's speech to job

status: open
origin: 2026-10-14 corrective production title audit; candidate `3a80349b861f60047c378ad7c0cd227e729b5fc3`
area: x title content fidelity

two retained titles make job the apparent speaker, although both captured sources explicitly say the lord speaks to job:

- media `944db4ed-5dad-421c-be09-734f1291f25b`: `Job's whirlwind speech as a joke about structural oppression`; job `d770332f-76f6-46f6-a6a0-f1330d887077`; generation `920b7047-c11c-42ed-bd43-c8cf963143c9`.
- media `bef70207-43c6-4829-9a91-4ae008bbc4e0`: `Job’s whirlwind speech in the voice of a relationship cliché`; job `102e7c8b-f22d-42bb-8dec-94164c39f48c`; generation `cf42aa01-9202-4c1e-9cab-ed75b373cd31`.

these successful runs predate the corrective release and were outside its 30-source recovery cohort. strict output shape, source versions, ledger usage, and no-tool checks pass; semantic attribution fails. two reviewers independently confirmed the error. treating the possessive as shorthand for the biblical book would conceal it.

prerequisite: retain each current normalized snapshot and the old operation history. correct the labels through the normal tracked naming owner, preserving who speaks to whom. if prompt correction is needed, express the general speaker/listener rule rather than a biblical special case. no direct database title rewrite.

acceptance: both current titles faithfully identify the lord's reply to job, or use their exact source labels after successful abstention; current source identity is unchanged; each new operation and its usage are accounted for; no research tools or unrelated metadata changes. keep the failed acceptance receipt visible until rechecked.

evidence: `/private/tmp/nexus-x-titles-proof-20261014/production-title-recovery-mechanical.json` and the accompanying full-collection content audit. the six original language/null defects and all 30 corrective parent titles passed; this is separate remaining work.
