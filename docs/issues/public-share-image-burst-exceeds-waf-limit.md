# a picture-heavy shared epub chapter outruns the share rate limit

**problem**: the public reader fetches every image of a unit at once when the unit mounts
(`lib/documentReader/text/TextSurface.tsx` hydrates per unit; `app/s/publicSource.ts`
`hydrate`), and the vercel WAF allows 120 requests a minute per ip on the whole share path
(`deploy/vercel/firewall/resource-sharing.json`). a chapter with more than ~110 images
loses the excess: those fetches answer 429 and the images stay empty, silently (a failed
image is not retried, by design: a retry would only deepen the limit).

**impact**: image-heavy books (atlases, comics, plate books) shared by link show blank
images until the reader reloads a minute later.

**evidence**: the WAF rule and the per-unit hydrate above; the summary, document and pdf
ranges share the same 120/min budget.

**resolved when**: a shared epub chapter with 150 images shows every image. options: raise
the limit, give `/assets/` its own higher limit, or hydrate images as they near the
viewport.
