# offline reader csp blocks canvas grain image

status: open
origin: 2026-09-25 article-section-navigation physical offline verification
area: offline reader presentation

the downloaded web article opened and its document map worked with no network,
but the webview console reported an `img-src 'self'` csp refusal for a
`data:image/svg+xml` noise image. `apps/web/src/app/globals.css:196,291`
declares the canvas grain as data svg. the impact appears limited to decoration;
the exact rendered difference has not been reviewed.

prerequisite: identify which offline stylesheet and csp owner combine to use
this token, and compare the offline surface with the intended canvas. repair at
the asset/style boundary without broadening offline network access.

acceptance: the offline reader renders the intended canvas without a csp
warning, while the offline document remains network isolated.
