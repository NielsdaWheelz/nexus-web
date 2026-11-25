# alter's reader map is slow to build

the native `8e22d112` rehearsal spent 7.730–9.114 s building alter's
15,185,737-byte map on first and repeat requests. at 448 mib the api and
database used about 7 s of cpu per map with under 30 ms of api memory stalls.
the reader waits for this data to place navigation and evidence.

measure which queries and response-building steps dominate. close when both
first and repeat requests meet 6 s with matching map contents and working
reader navigation. see [the native measurements](api-reader-search-memory-margin-remains-small.md).
