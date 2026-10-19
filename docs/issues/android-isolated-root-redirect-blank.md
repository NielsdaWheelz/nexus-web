# android isolated root opens blank before login

status: open; isolated unauthenticated redirect origin unexplained
origin: 2026-09-25 article-section-navigation downloaded-reader acceptance
area: android hosted webview / local stack

the candidate debug app's native webview showed an empty 39-byte `about:blank`
document with CDP target `http://127.0.0.1:65230/`. the isolated server answered
that root with a 307 to `/login?next=%2F`; the phone's external browser loaded
the site. a direct owned `/login?next=%2F` deep link then rendered the native
webview login. no matching `onReceivedError` or `net::` error appeared in the
app log; CDP navigation to the root returned `net::ERR_ABORTED`.

prerequisite: reproduce from a clean candidate-app start with the standalone
server already healthy, network validation known, and no restored blank
webview state. the isolated standalone server was started with
`HOSTNAME=127.0.0.1` and `APP_PUBLIC_URL=http://127.0.0.1:65230`, yet
unauthenticated root requests with either host and either forwarded-host header
all returned `location: http://localhost:65230/login?next=%2F`. an authenticated
cold relaunch restored the article normally. inspect next standalone origin
normalization and the app's relative login redirect; distinguish an isolated
server behavior from the canonical hosted origin before changing auth code.

acceptance: clean app launch from the owned root reaches login or workspace
inside the native webview; no blank document remains.
