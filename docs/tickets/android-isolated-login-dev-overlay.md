# android isolated login shows dev overlay

status: open; development-only failure not yet attributed
origin: 2026-09-25 article-section-navigation offline acceptance
area: android hosted login / local development

on the connected SM_S906W, a candidate debug APK opened its login through
Firefox Custom Tab (`org.mozilla.fenix.customtabs.ExternalAppBrowserActivity`).
after submitting the disposable account's password against isolated Next
`127.0.0.1:65230` and Supabase Auth `:65211` through task-owned adb reverses,
the page showed a Next dev overlay: `Runtime SyntaxError: JSON.parse: unexpected
end of data at line 1 column 1`, `src/app/login/page.tsx (68:5) @ LoginPage`.
the attempt never reached offline package download. adb logcat gave no matching
console line. candidate screenshot was saved to the temporary run receipt.
the same disposable password flow later succeeded inside the native webview
against a production standalone build, and a real offline package downloaded.
an external custom-tab attempt also exposed a separate temporary callback-origin
allowlist mismatch (`localhost:65230` versus `127.0.0.1:65230`), corrected in
the isolated runtime configuration. neither observation identifies the dev
overlay's failing json response.

prerequisite: identify the failing JSON response and whether it is a temporary
reverse/origin configuration error or a login-page defect. reproduce against a
clean isolated dev stack without altering an existing account or stored data.
repair at the response/auth boundary; do not weaken parsing or bypass login.

acceptance: identify and repair the malformed development response, then sign
in through the native webview on the isolated dev server without an overlay;
record the request and response. the standalone success does not prove this.
