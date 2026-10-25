# desktop browser entry depends on a live server

target gap: v1 local-first writing must cold-open in the desktop browser without
a connection. local note storage alone cannot supply an executable application.

evidence: `apps/web/src/app/(authenticated)/layout.tsx:24-30` awaits server session
verification and render environment; `:48-57` awaits workspace bootstrap.
android separately owns bundled delivery and a provisioned local account in
`docs/modules/device-startup.md`.

impact: browser restart or offline navigation can prevent access to otherwise
durable local writing. browser shell delivery, local account admission, routing
and asset availability need an explicit offline entry contract.

resolved when a previously provisioned supported desktop browser can close,
restart, open a deep link, edit and restart again while offline, without a
successful server request or cross-account content exposure.
