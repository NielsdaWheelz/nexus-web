# android second reader fails before request

on the task-owned android 35 emulator, opening a second web article through an
app link after accepting a first article download showed “couldn’t open this
document”. the media detail request returned 200, but no request for the second
article's `/reader` endpoint was observed; the first article's reader and
reader-state requests returned 200. this blocked that native shelf attempt and
required a reader retry.

evidence: private lab `20261028-195928-536ba50331c8`,
`artifacts/playwright/recent-native-shelf-downloaded-shelf-open-becomes-recent/error-context.md`;
the server-side fixture successfully read both published documents. in lab
`20261028-201055-cfc1ad7609ee`, the reader retry recovered and both reader
endpoints returned 200. the initial refusal cause remains unproven.
resolved when the cause is fixed and the
same real app-link/download sequence opens the second reader without a retry.
