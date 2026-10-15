# a flat-tree scanned shared pdf past ~600 pages outruns the share byte limit

**problem**: pdf.js resolves its first and last page through `Catalog.getPageDict`, which
fetches every kid of the root `/Pages` at once (`pdf.worker.mjs` `pageDictCache.put(lastKid,
xref.fetchAsync(lastKid))`). in a pdf whose page dicts sit between large image streams, with
no object streams and one flat `/Kids` array (scanned books, plate books), each kid
the `bytes=0-` stream has not reached costs one range read, all in parallel. the share's
byte reads get 600 a minute per ip (`deploy/vercel/firewall/resource-sharing-bytes.json`);
past it a read is denied (403), the reader shows "This PDF could not be opened." with Retry,
and Retry repeats the burst.

**impact**: such pdfs past ~600 pages do not open by public link. balanced page trees,
pdfs with object streams and text pdfs open in a handful of reads. it predates the share
rewrite: the base's url mode issued the same reads.

**evidence**: pdfjs-dist 5.7.284 under node, a generated interleaved image pdf (76.8 kB per
page) opened through a `PDFDataRangeTransport` as `PdfSurface.tsx` `hostRanges` does
(`disableAutoFetch`, stream at 6.4-25 MB/s, 40 ms per range read), range reads at open:
200 pages 187-199, 600 pages 573-598, 700 pages 672-698; each plus the one stream request.
earlier runs (30-50 ms reads): the same pages with object streams cost 12-13 reads for 60
pages; a 300-page text pdf 3-4 reads for find over every page; with `rangeChunkSize` 1 MiB
the 200-page open drops to 16 reads (and every miss reads up to 1 MiB).

**resolved when**: a 1,000-page flat-tree interleaved scan opens on `/s` and its last page
renders within the limit (a harness journey counts its `/file` reads). options: a larger
`rangeChunkSize` for the share transport, or `hostRanges` holding range reads the stream
is about to reach.
