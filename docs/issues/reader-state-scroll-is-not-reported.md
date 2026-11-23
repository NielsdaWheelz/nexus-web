# reader loading and failure scroll is absent from the pane foot

`apps/web/src/lib/documentReader/DocumentReader.tsx` renders its waiting and
failed bodies in the reader state scroller. only the text and pdf surfaces
publish a scrollport to the host. a long state message can scroll above the
reader while the pane foot stays clear.

close when the reader exposes its state scrollport to the existing host
callback, and scrolling down and back in a long failed state lights and clears
the same foot. switching to a ready text or pdf must release the old port.
