# pdf resource publication reopens an unchanged binary

- status: open
- origin: 2026-09-14 composed reader residency review
- area: hosted pdf loading

`useDocumentReaderSession.ts:80` publishes a fresh ready-resource wrapper on every render. `PdfReader.tsx:3010` depended on that whole wrapper, so unrelated body updates restarted the loading effect for the same selected source and grant. composed restore runs `79781963c409daca` and `5c364c04849a2785` observed five and six physical workers for two rendered readers. no hidden descriptor or binary reads were observed; those worker counts alone do not identify hidden-pane ownership.

fix staged: preserve selected-publication reader keys and depend on source status, url, expiry, and error instead of the wrapper. preserve pending-task destruction, range delivery, source replacement, and tagged errors with null payloads.

acceptance: the actual host retains only its displayed readers' workers after source publication; unrelated updates preserve each worker, actual source/grant replacement retires it, and close removes every task. distinguish initial cancellation overlap from retained workers. demonstrate the faulty publication and corrected behavior through the real pdf.js boundary.
