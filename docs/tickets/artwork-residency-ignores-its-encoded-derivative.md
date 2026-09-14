# artwork residency charges decoded pixels only, not the retained encoded derivative

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: browser artwork memory

## what is wrong

`apps/web/src/lib/media/artwork.ts:272` accounts `residentPixels` only, while
every `Ready` entry **also** retains an object-URL blob re-encoded as lossless
PNG. the PNG re-encode systematically inflates that retained cost — a flat-colour
cover encodes small, a photographic one does not — and the capacity receipt could
not see it at all.

it can now be seen but not charged: `ArtworkCapacity.browser.test.tsx` takes the
`loaded` heap/native snapshot first and then measures every retained derivative's
actual encoded size (a fetch of the entry's object URL), recording
`derivativeBytes` per profile, so the unmeasured retention is visible in evidence.

## prerequisites

three things must land together or the accounting is half-applied:

- a committed combined byte limit in `apps/web/src/lib/media/artworkCapacity.ts`
  and its `ArtworkProvider` callers, so the reservation is pixels **and** bytes.
- content-chosen encoding (`convertToBlob` webp for photographic covers) together
  with `apps/web/src/lib/player/mediaSession.ts:211`, which hardcodes
  `type: "image/png"` for the OS artwork consumer.
- a photographic fixture in `testdata/capacity/artwork.json`; today the receipt
  measures flat-colour and metadata cases only, which are the cheap end of the
  distribution.

the byte limit is a qualification output, not a guess — it depends on the same
measurement the image-admission ticket owns.

## proposed fix

convert the reservation to a combined pixel+byte budget, choose the derivative
encoding by content, and add the photographic profile so the receipt measures the
expensive case.

## acceptance

the artwork capacity receipt reports decoded pixels and retained encoded bytes
against a committed budget for a photographic cover, and a derivative that would
exceed the byte budget is refused the way an over-pixel one is.
