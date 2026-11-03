# x article unreadable guidance exceeds the composed line limit

problem: the unreadable x-article message has twelve fixed words; popup adds the
five-word “this page can’t be saved.” fact, producing seventeen.

source at06315275 under apps/web/src: `extension/content.ts:111` returns unreadable
when request.x_article and extractXArticle returns null; `background.ts:670-675`
passes its message into the unsupported draft; `popup.tsx:231` renders the composed
Line. this is an actual displayed path, not a generic failed content reply.

keep the outer fact and shorten only this reason to “open its reading view, then
capture again.” preserve the real offered remedy, without inferring another cause.

resolved when the actual composition is twelve lowercase fixed words and its
unchanged producer path passes independent review and the canonical static gate.
