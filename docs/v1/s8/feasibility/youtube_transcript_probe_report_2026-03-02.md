# youtube transcript feasibility probe report (2026-03-02)

## scope

- fixture dataset: `python/tests/fixtures/youtube_transcript_probe_samples.json`
- reproducibility test: `python/tests/test_youtube_transcript_feasibility.py`
- contract target: `s8 pr-01` transcript feasibility + playback-only fallback behavior

## probe dataset summary

- total probes: `8`
- transcript success (`status=completed`): `4` (`50.0%`)
- transcript unavailable (`E_TRANSCRIPT_UNAVAILABLE`): `3` (`37.5%`)
- transient provider timeout (`E_TRANSCRIPTION_TIMEOUT`): `1` (`12.5%`)

## representative failure modes covered

- uploader-disabled captions
- age-restricted transcript unavailability
- region-restricted transcript unavailability
- provider timeout

## playback-only fallback verification

- all failed probes preserve `playback_available=true`
- all `E_TRANSCRIPT_UNAVAILABLE` probes assert `expected_playback_only=true`
- this matches ingest terminal semantics: transcript-unavailable is terminal for transcript capabilities, but playback remains available

## how to rerun

```bash
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest -v tests/test_youtube_transcript_feasibility.py"
```
