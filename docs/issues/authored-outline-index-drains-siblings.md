# describe large unfiltered outline branches by rank

`OutlineController.observeStructure` calls `readAuthoredIndex` for every
disclosed parent even when the filter is empty. it drains the `outline_filter`
ranges to size gaps. rich `outline_windows` reads stay bounded and can already
locate a known link id. opening large branches still transfers every adjacent
key before the complete structural extent is usable.

replace the unfiltered scan with a revision-scoped count and rank seek that
applies traversed-edge omission before ranking. use the same order for measured
gaps and mounted proofs. keep full adjacency examination for explicit text
filtering. qualify large end and deep return, disclosure, repeated resources,
terminal cycles and editing proof on firefox and the paired webview.
