# a scanned shared pdf can outrun the share rate limit while it opens

**problem**: pdf.js asks for every chunk it needs before the whole-file stream reaches it,
in parallel, one 64 kB range read per chunk group. opening a pdf without object streams
whose page dicts sit between large image streams (scanned books, plate books) walks the
page tree, so it costs about one range read per page at once. the vercel WAF allows 120
requests a minute per ip on the whole share path
(`deploy/vercel/firewall/resource-sharing.json`); past it a read answers 429, the reader
shows "This PDF could not be opened." with Retry, and Retry repeats the burst.

**impact**: such pdfs (a few hundred pages and up) may not open by public link; text pdfs
and pdfs with object streams open in a handful of reads. it predates the share rewrite:
the base's url mode issued the same reads.

**evidence**: pdfjs-dist 5.7.284 under node against a generated 200-page, 15.5 MB image pdf
with no object streams, the stream at 6.4-25 MB/s and 30-50 ms per range read: 188-196
range reads at open in the base's url mode, 192-198 with the share transport
(`lib/documentReader/pdf/PdfSurface.tsx` `hostRanges`); the same pages with object streams:
12-13 reads for 60 pages; a 300-page text pdf: 3-4 reads for find over every page. with
`rangeChunkSize` 1 MiB the 200-page open drops to 16 reads (and every miss reads up to
1 MiB).

**resolved when**: a 200-page interleaved image pdf opens on `/s` and its last page renders
within the limit (a harness journey counts its `/file` reads). options: a larger
`rangeChunkSize` for the share transport, or a separate, higher WAF limit for `/file`.
