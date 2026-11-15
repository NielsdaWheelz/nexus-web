# svms pdf text ingestion reaches its resource limit

importing the repository's `content/svms.pdf` in a disposable lab leaves the
original readable but produces no text chunks. content search cannot return its
passages. this is outside the headword presentation change.

evidence: baseline `8a16a039a`, lab `20261114-174246-02423ba63837`:
`ingest_media_source` job `01a1dce0-24d2-71cc-8612-3f1b3bc039d2` is held with
`E_RESOURCE_LIMIT` and `Background job exceeded its memory limit.`; `content_chunks` contains
24 chunks for `attention.pdf`, 38 for `diffusion.pdf`, none for `svms.pdf`.
all three were uploaded together through the library's `Import here` command.

reproduce with the normal disposable lab, import that file and inspect the
source obligation and text publication. determine which parser budget is
exhausted before changing limits. resolved when the normal import publishes
searchable text within the production resource budget, or the file is explicitly
classified as requiring an unsupported extraction path.
