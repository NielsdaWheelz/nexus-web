# media unit builds fail on source text the prompt set refuses

status: open (pre-existing on main; outside the reader python slice)
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness`)
area: media intelligence / generation

`media_unit_build` hands a media's text to `run_codex`, which wraps it in
`PromptText` (`python/nexus/services/generation/codex.py`, `sections`). the
pinned `llm_tools` validator refuses text outside its "XML-like presentation set"
(`llm_tools/prompt_sections.py` `_validate_xml_text`), so the job logs
`media_unit_build_failed_unexpected` with `ValueError: prompt value contains
text outside the XML-like presentation set` and the media gets no units.

impact: some ingested sources (the harness corpus holds several) never get the
derived units their reading and search features use; the failure is logged as
unexpected rather than settled as a typed outcome.

evidence: worker logs of the harness cycles (`2026-10-20/rpy/harness/runs/`),
on main and on the re-slice alike: `baseline-main.txt.logs/worker-background.container.log`
9 failures (33-file corpus), `base-ext.txt.logs/` 15 and `tip-1.txt.logs/` 18
(60-file corpus). which characters trip it was not established (the reader
python slice does not own this path).

resolved when the offending characters are identified and either escaped or
removed before prompting (or the validator accepts them), and a harness cycle
logs no `media_unit_build_failed_unexpected`.
