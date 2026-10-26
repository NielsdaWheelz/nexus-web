# outline command accessory above the ios keyboard is unobserved

status: open verification concern. the fix landed in the outline touch accessory
change; no ios device or simulator was available to observe it.

before that change, `apps/web/src/components/workspace/PaneShell.tsx` applied
keyboard clearance to the outline command accessory only in the mobile layout.
touch devices classified desktop (ipad portrait above 768px, large phones in
landscape above 900px; see [the cutoff ticket](phone-landscape-exceeds-mobile-layout-cutoff.md))
showed the accessory at the pane's bottom, under the ios keyboard, which overlays
the layout viewport. clearance is now measured whenever the accessory renders, so
the accessory should sit above the keyboard. android resizes content, so its
inset is about 0 either way.

prerequisite: an ipad, or a large iphone in landscape, running safari or the web
app in desktop layout.

resolved when, with the soft keyboard open while editing an outline item, the
accessory sits above the keyboard and the caret row stays reachable. record the
device, os and build.
