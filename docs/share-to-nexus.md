# Share to Nexus — Android Share-Sheet Capture

Status: Implemented. Hard cutover: no feature flag, no fallback, no legacy
path; the feature ships whole on one branch.
Scope owner: the Android share surface (`apps/android`) and the `/share` route
(`apps/web`).
Date: 2026-05-19.

## 1. Problem

Nexus already ingests external content well. `POST /media/from_url`
(`python/nexus/api/routes/media.py:139`) classifies and ingests any URL — a
YouTube link becomes a `video`, a public X/Twitter post becomes an official
X API-backed same-author thread `web_article`, a `.pdf`/`.epub` URL becomes
file-backed media, and every other URL becomes an extracted `web_article`.
`POST /notes/daily/{date}/quick-capture` (`python/nexus/api/routes/notes.py:106`)
appends free text to today's daily note. The browser extension reaches this
pipeline from the desktop; the in-app Add-content tray reaches it from a running
session.

Nothing reaches it from the *rest of an Android phone*. The Android app
(`apps/android`) is a WebView shell whose only `<intent-filter>`s on
`MainActivity` are `MAIN`/`LAUNCHER` and an App-Links `VIEW` filter
(`apps/android/app/src/main/AndroidManifest.xml:13-34`). It declares no
`ACTION_SEND` filter, so **Nexus never appears in the Android system share
sheet**. A user reading a tweet, an article in Chrome, or a video in the YouTube
app cannot send it to Nexus without leaving that app, opening Nexus, opening the
Add-content tray, and pasting.

The gap is a missing *trigger surface*, not a missing capability. This document
specifies that trigger surface.

## 2. Goals

- A user sharing from any Android app (browser, X, YouTube, Reddit, …) sees
  **Nexus** in the system share sheet.
- Choosing it captures the shared URL or text into the user's library or daily
  note, confirms in a compact surface, and returns the user to the app they came
  from.
- The capture path is the **existing** ingestion pipeline. The feature adds a
  trigger and a thin confirmation surface; it adds no ingestion logic, no API
  route, no server action, no database column, and no auth mechanism.
- One capture path. No background-POST variant, no PWA variant, no feature flag.

## 3. Target behaviour

### 3.1 The share-sheet entry

With the app installed, every `text/plain` share from any Android app lists
**Nexus** (the app label and icon). The entry is served by a new activity,
`ShareActivity`, registered with an `ACTION_SEND` intent filter. `ShareActivity`
runs as its own surface: it does not join `MainActivity`'s task or touch its
back-stack, and finishing it returns the user to the app they shared from.

### 3.2 The capture surface — `/share`

`ShareActivity` hosts a WebView that loads `<NEXUS_BASE_URL>/share?text=<shared
text>`. `/share` is a new route rendering a **compact centred card** — not the
authenticated app shell. It does not mount the navbar, the workspace pane
canvas, the command palette, or the global player. It captures on load and shows
the outcome. The compactness is a web concern (the card sits on a dimmed
backdrop); `ShareActivity` is a plain WebView host.

### 3.3 Content mapping

`ShareCapture` classifies the shared text once, on mount, with `extractUrls`
(§6.6). The result maps to an existing endpoint:

| Shared `text/plain` | Capture |
|---|---|
| Contains one or more URLs | One `POST /api/media/from-url` per URL. The backend classifies each (YouTube → `video`, public X/Twitter post → official X API-backed same-author thread `web_article`, `.pdf`/`.epub` → file media, else extracted `web_article`) — unchanged. |
| Plain text, no URL — a quote or thought | One `POST /api/notes/daily/{today}/quick-capture` — a bullet on today's daily note. |
| Empty / whitespace | Nothing. `ShareActivity` finishes before loading `/share`; `ShareCapture` also renders `nothing to share` defensively if it is reached with empty text. |

A share whose text contains a URL *and* surrounding prose captures the URL:
`extractUrls` returns a non-empty result and each URL is captured as media.
X/Twitter shares — frequently `"<tweet text> https://x.com/…/status/123"` —
therefore capture the post.

### 3.4 Capture states

`/share` renders a small state machine. The capturing state is the only
non-terminal one:

- **capturing** — the card shows progress ("Saving to Nexus…"). Capture
  auto-fires on mount; the user taps nothing.
- **captured** — at least one item succeeded; the heading is **Saved to Nexus**.
  The card lists each result: a media capture shows its URL and whether it was
  newly **Saved** or was **Already in your library** (the from-url `duplicate`
  flag); a note shows **Added to today**. Each succeeded media row offers **Open
  in Nexus**, a succeeded note row offers **Open**; the card offers **Done**.
  Failed items in the same multi-URL share are listed as **Couldn't save** with
  a card-level **Retry**.
- **failed** — every item failed for a non-auth reason (network, backend, an
  invalid URL the backend rejected); the heading is **Couldn't save**. Each item
  shows **Couldn't save**; the card offers **Retry** and **Done**.
- **sign-in required** — there is no usable session (see §3.6); rendered by
  `page.tsx`, not `ShareCapture`.
- **nothing to share** — empty/whitespace text. Defensive; `ShareActivity`
  normally prevents it. The card shows a short message and **Done**.

Capture success means the backend returned `2xx` with a `media_id` (or created
the note block). It does **not** mean the item is finished processing: a general
article returns `202` with `processing_status: "pending"` and extracts in a
worker; an X/Twitter post returns `ready_for_reading` synchronously. The card
confirms the *capture*, never blocks on processing, and the reader handles the
processing state when the item is opened.

### 3.5 Dismissal and hand-off

The card's actions cross the native boundary through a `nexus-share://` URL
scheme (§6.4). It is an internal WebView hand-off, separate from the registered
`nexus://auth/handoff` auth return scheme:

- **Open in Nexus** (a media row) and **Open** (a daily-note row) navigate to
  `nexus-share://open?path=/media/<id>` or `nexus-share://open?path=/daily`.
  `ShareActivity` intercepts it, launches `MainActivity` at that path, and
  finishes itself. The user lands in the full app on the captured item.
- **Done** navigates to `nexus-share://dismiss`. `ShareActivity` finishes; the
  user returns to the app they shared from.

### 3.6 Unauthenticated behaviour

The share surface never hosts a login flow. If the session cookie is `ended` or
`anonymous` (§6.5), `/share` renders the **sign-in required** state: a message to
open Nexus and sign in, then share again. It does not start OAuth — an OAuth
round-trip's callback is an App-Links `VIEW` intent bound to `MainActivity`,
which would abandon `ShareActivity` mid-flow. A `refreshable` session is not a
logged-out state: the capture call refreshes it inline (§6.5), so `refreshable`
proceeds to capture normally. Only a genuinely ended session is terminal here.

This is a deliberate, narrow contract: a logged-out user loses the pending share
and re-shares after signing in. The realistic frequency is near zero — a user
with the app installed has a live session — and it is the price of never
trapping a share behind a login redirect.

## 4. Architecture

The feature is two thin surfaces bolted onto an unchanged pipeline. The seam is
the `/share` route: north of it is new code, south of it is the existing
ingestion stack, untouched.

```
Android system share sheet            any app — Chrome, X, YouTube, Reddit, …
  │  ACTION_SEND · text/plain · EXTRA_TEXT
  ▼
ShareActivity                         NEW (apps/android) — own task, own WebView
  │  builds <NEXUS_BASE_URL>/share?text=… and loads it
  │  WebViewClient intercepts the nexus-share:// scheme only
  ▼
/share — app/share/page.tsx           NEW (apps/web) — server component
  │  reads ?text, the session cookie (readSupabaseSessionCookie), the User-Agent
  ├── session ended / anonymous ─────▶ inline sign-in-required card
  └── session active / refreshable ──▶ <ShareCapture text= isShell=/>   client
        │  on mount, extractUrls(text) classifies the share:
        │    non-empty result → addMediaFromUrl()  per URL  (existing client fn)
        │    empty result     → quickCaptureDailyNote()     (existing client fn)
        ▼
/api/media/from-url · /api/notes/daily/[date]/quick-capture   EXISTING BFF routes
  │  proxyToFastAPI — cookie session, inline refresh, CSRF Origin check
  ▼
FastAPI /media/from_url · /notes/daily/{date}/quick-capture   UNCHANGED
```

**Why a WebView route and not a native capture POST.** A native activity could
hold a scoped token and POST to the backend directly — the browser extension's
model (`Authorization: Bearer`, `/api/media/capture/*`). That is rejected here on
`cleanliness.md`'s "one owner per concern": it would be a *second* ingestion
client with a *second* auth mechanism (a new token type, native HTTP, native
secure storage, native error surfacing) parallel to the in-app Add-content tray.
The WebView route reuses the in-app capture client functions verbatim and the
existing cookie session. The capture concern keeps exactly one owner. The cost —
a ~1s WebView card instead of an invisible toast — is the honest trade for zero
new auth surface.

**Why a separate `ShareActivity` and not an `ACTION_SEND` filter on
`MainActivity`.** `MainActivity` is `launchMode="singleTask"` and owns the
running app, its back-stack, and the App-Links `VIEW` flow. Routing shares
through it would interleave a transient capture surface with the user's live
workspace. A separate activity with its own task is the clean decomposition: the
share surface is born, captures, and dies without ever perturbing the main app.

## 5. Capability contract

The feature is the path from an Android `ACTION_SEND` intent to a confirmed
capture.

- **Inputs:** an `ACTION_SEND` intent with type `text/plain` and a non-empty
  `EXTRA_TEXT` CharSequence; the process-wide WebView `CookieManager` (carrying
  the Supabase session); `BuildConfig.NEXUS_BASE_URL`.
- **Outputs:** zero or more `media` rows and/or one daily-note `note_block`,
  owned by the authenticated viewer; for media with no `library_id`, the
  viewer's default library (`Library.is_default`, resolved by the backend). A
  confirmation surface. On **Open in Nexus**, `MainActivity` foregrounded at the
  captured item.
- **Invariants:**
  - The feature adds no ingestion logic. Every capture is an existing endpoint
    called through an existing client function.
  - URL capture is idempotent: re-sharing a URL yields a `duplicate` result and
    no second media row. Daily-note capture is *not* idempotent, so `ShareCapture`
    fires the capture once per attempt behind a `useRef` guard — safe against
    React's mount-effect double-invoke.
  - No capture occurs without a usable session; `ended`/`anonymous` is terminal.
  - `/share` mounts no app-shell chrome — no navbar, workspace, palette, player.
  - `ShareActivity` never disturbs `MainActivity`'s task or back-stack.
  - The `/share` page, inside the shell, navigates only to its initial URL and
    to `nexus-share://` URLs — never off-route. `ShareActivity`'s `WebViewClient`
    relies on this and carries no external-URL routing.
  - The session four-state branch in `page.tsx` is exhaustive
    (`control-flow.md`): a `never`/`satisfies` check on `session.state`.
- **Failure modes:** empty/whitespace `EXTRA_TEXT` ⇒ `ShareActivity` finishes
  without loading `/share`. An `ended`/`anonymous` session cookie ⇒ the
  `sign-in required` card (the page-render gate). Any capture-call failure ⇒ a
  retryable `failed` state, per item. A malformed `nexus-share://` URL ⇒
  `ShareActivity` finishes (treated as dismiss). None of these surface a crash.

## 6. API design

The feature adds **no API route and no server action**. URL capture reuses the
existing BFF route `apps/web/src/app/api/media/from-url/route.ts`
(`proxyToFastAPI(req, "/media/from_url")`); note capture reuses the existing
`apps/web/src/app/api/notes/daily/[localDate]/quick-capture/route.ts`. Both are
called through the existing client functions below.

### 6.1 Android manifest — the `ShareActivity` entry

`apps/android/app/src/main/AndroidManifest.xml` gains one `<activity>` inside
`<application>`. `MainActivity` is unchanged.

```xml
<activity
    android:name=".ShareActivity"
    android:exported="true"
    android:excludeFromRecents="true"
    android:taskAffinity=""
    android:theme="@style/Theme.Nexus">
    <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="text/plain" />
    </intent-filter>
</activity>
```

- `exported="true"` — required for a share target on Android 12+.
- `taskAffinity=""` — `ShareActivity` is its own task root, not joined to
  `MainActivity`'s task.
- `excludeFromRecents="true"` — the transient surface does not linger in Recents.
- No `android:label` — the share-sheet entry inherits the app label ("Nexus",
  `strings.xml`) and icon. `cec098e`'s "one owner per concept" for icons holds:
  the share entry is the app icon.
- No new `<uses-permission>` — `INTERNET` is already declared app-wide.
- `assetlinks.json` is unchanged: `ShareActivity` handles `ACTION_SEND`, not
  App-Links `VIEW`.

### 6.2 `ShareActivity` — `apps/android/.../ShareActivity.kt` (new)

A minimal activity: read the shared text, load `/share`, intercept
`nexus-share://`.

```kotlin
class ShareActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sharedText = intent
            ?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getCharSequenceExtra(Intent.EXTRA_TEXT)
            ?.toString()
            ?.trim()
        if (sharedText.isNullOrEmpty()) {
            finish()
            return
        }
        webView = WebView(this)
        NexusWebView.configure(webView)            // the one WebView-config owner
        webView.webViewClient = /* anonymous WebViewClient — see below */
        setContentView(webView)
        webView.loadUrl(/* <NEXUS_BASE_URL>/share?text=… */)
    }
    // onPause/onResume drive the WebView lifecycle and flush cookies;
    // onDestroy stops loading, detaches, and destroys the WebView.
}
```

- The shared text is trimmed and used verbatim; there is no length cap.
- The `/share` URL is built inline — `Uri.parse(BuildConfig.NEXUS_BASE_URL)
  .buildUpon().appendEncodedPath("share").appendQueryParameter("text", …)`.
- An anonymous `WebViewClient` overrides two methods.
  `shouldOverrideUrlLoading`: if `uri.scheme` is the `nexus-share` scheme, act on
  it (§6.4) and return `true`; otherwise return `false` (load in place).
  `onPageFinished` calls `CookieManager.getInstance().flush()` so a
  session-cookie rotation triggered by the capture call (a `refreshable`
  session, §6.4) is persisted process-wide — the same flush `MainActivity`
  performs. `onPause` flushes the cookie store again.

### 6.3 `NexusWebView` — the one WebView-configuration owner (new)

`MainActivity` currently configures its WebView through a private
`hardenWebView` method (`MainActivity.kt:231`) used for both the main WebView and
the `onCreateWindow` popup WebView. `ShareActivity` needs the identical
hardening. Per `cleanliness.md` ("one concern, one owner") this configuration is
extracted to one owner; `hardenWebView` is **deleted** (hard cutover, not a
re-export).

```kotlin
object NexusWebView {
    const val USER_AGENT_TOKEN = "NexusAndroidShell"

    fun configure(view: WebView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(true)
        settings.userAgentString = "${settings.userAgentString} $USER_AGENT_TOKEN"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    }
}
```

`MainActivity` cuts over: both `WebView(this)` instantiations call
`NexusWebView.configure(...)`; the standalone
`WebView.setWebContentsDebuggingEnabled` and `cookieManager.setAcceptCookie`
calls in `MainActivity.onCreate` are absorbed into `configure` and removed. The
hardcoded `"NexusAndroidShell"` string becomes `NexusWebView.USER_AGENT_TOKEN`;
it names the same concept the web side names `ANDROID_SHELL_USER_AGENT_TOKEN`
(`apps/web/src/lib/androidShell.ts`) — the two cannot share a literal across the
language boundary, but they are named consistently and each is a single constant.

`ShareActivity`'s `WebViewClient` is deliberately *not* shared with
`MainActivity`'s: the two activities have genuinely different navigation
concerns (`MainActivity` routes external URLs to Custom Tabs and manages popup
windows; `ShareActivity` only intercepts `nexus-share://`). Sharing only the
hardening — the one concern that is identical — is the correct boundary.

### 6.4 The `nexus-share://` scheme

A custom scheme carries two signals from the `/share` web page to
`ShareActivity`, using the same native-owned custom-scheme interception pattern
as the current `nexus://auth/handoff` OAuth hand-off to `MainActivity`
(`apps/web/src/lib/auth/redirects.ts`, `MainActivity.kt`). It uses no
`addJavascriptInterface` — consistent with the current shell, which has no JS
bridge.

| URL | `ShareActivity` action |
|---|---|
| `nexus-share://open?path=<root-relative path>` | Validate `path` begins with a single `/`. Launch an explicit `Intent(this, MainActivity::class.java)` with `data = <NEXUS_BASE_URL><path>`. `MainActivity` (`singleTask`) routes it through its existing `loadUrlFromIntent`. Then `finish()`. |
| `nexus-share://dismiss` | `finish()`. |

The scheme name and its two hosts (`open`, `dismiss`) and the `path` parameter
name are named Kotlin constants. A URL that matches the scheme but neither host,
or whose `path` is not root-relative, is treated as `dismiss`.

### 6.5 `/share` route — `apps/web/src/app/share/page.tsx` (new)

A server component under the **root** layout (`apps/web/src/app/layout.tsx`),
not the `(authenticated)` group — the `(authenticated)` layout renders the full
`AuthenticatedShell`, which `/share` must not mount.

It reads `?text`, the session cookie through the boundary parser
`readSupabaseSessionCookie` (`apps/web/src/lib/auth/session-cookie.ts`) — the
same four-state union the middleware and DAL consume — and `isShell`, then
branches exhaustively on the session state:

```tsx
export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ text?: string }>;
}) {
  const sharedText = (await searchParams).text ?? "";
  const session = readSupabaseSessionCookie((await cookies()).getAll());
  const isShell = isAndroidShellUserAgent(
    (await headers()).get("user-agent") ?? "",
  );

  let content: React.ReactNode;
  switch (session.state) {
    case "active":
    case "refreshable":
      content = <ShareCapture text={sharedText} isShell={isShell} />;
      break;
    case "ended":
    case "anonymous":
      content = /* inline sign-in-required card — see below */;
      break;
    default:
      session satisfies never;
  }

  return (
    <div className={styles.backdrop}>
      <main className={styles.card}>{content}</main>
    </div>
  );
}
```

`page.tsx` owns the backdrop and card chrome; it passes the raw `text` straight
to `ShareCapture` without classifying it — classification is `ShareCapture`'s
job (§6.7). `active` and `refreshable` render `<ShareCapture>`; `ended` and
`anonymous` render the **sign-in required** card *inline* — a heading, a one-line
message, and a single **Done** action (`nexus-share://dismiss` when `isShell`,
else a link to `/`). There is no separate sign-in component or file.

It does **not** call `verifySession` (`dal.ts`): `verifySession` redirects to
`/login` on a missing session, which is exactly the login trap §3.6 forbids.
`/share` owns its own auth UX. `active` and `refreshable` both proceed — a
`refreshable` cookie is refreshed inline by `proxyToFastAPI` when the capture
call fires. The page render does not verify the JWT signature; the cookie state
is the gate. `isShell` is computed once, server-side, from the User-Agent header
(the established server-side pattern — see `settings/page.tsx`) and passed down;
children never call the client-only `isAndroidShell()`.

Because `/share` renders its own auth-aware UI rather than bouncing to `/login`,
it is added to `PUBLIC_ROUTES` (§6.8) so the middleware passes it through in
every session state.

### 6.6 `extractUrls` — `apps/web/src/lib/extractUrls.ts` (new home)

`extractUrls` already existed, verbatim the logic this feature needs (URL regex,
trailing-punctuation trim, dedupe, `URL`-parse validation), but it was a
module-private function inside `AddContentTray.tsx`. `cleanliness.md` forbids
duplicating it. It is **moved** to the flat lib module
`apps/web/src/lib/extractUrls.ts` and exported; `AddContentTray.tsx` deletes its
copy and imports the shared one. Hard cutover — one owner, two consumers
(`AddContentTray`, `ShareCapture`), no re-export shim.

```ts
export function extractUrls(text: string): string[];
```

### 6.7 `ShareCapture` — `apps/web/src/app/share/ShareCapture.tsx` (new, client)

```tsx
function ShareCapture(props: {
  text: string;
  isShell: boolean;
}): JSX.Element;
```

`ShareCapture` receives the raw shared `text`. It classifies the text itself —
there is no separate parser. State:

- `results` — a `CaptureResult[]`, or `null` while capturing. `CaptureResult` is
  a discriminated union: `{ label; ok: true; status; path } | { label; ok: false }`.
- `attempt` — a counter that **Retry** increments to re-run the capture.
- A `useRef` guard so the capture fires once per `attempt`: React's strict-mode
  double-invoke of the mount effect would otherwise post a second daily-note
  bullet, since `quickCaptureDailyNote` is not idempotent.

On mount (and on each `attempt`) the effect trims `text` and:

- empty trimmed text → renders **nothing to share** directly, no capture call.
- `extractUrls(trimmed)` non-empty → `addMediaFromUrl({ url })` for each URL.
  The per-URL calls run under `Promise.all` over individual `try`/`catch`
  blocks, so each URL contributes its own success or failure to `results` — a
  multi-URL share is never all-or-nothing.
- `extractUrls(trimmed)` empty → `quickCaptureDailyNote({ bodyMarkdown: trimmed })`,
  a single bullet on today's daily note.

`addMediaFromUrl` (`apps/web/src/lib/media/ingestionClient.ts`,
`{ url, libraryId? } → { mediaId, duplicate }`) and `quickCaptureDailyNote`
(`apps/web/src/lib/notes/api.ts`, `{ bodyMarkdown, localDate? } → NoteBlock`) are
reused unchanged — the same functions the Add-content tray calls. No `libraryId`
is passed: the backend files the media in the viewer's default library. The card
renders the §3.4 states; on a successful media capture it shows **Saved** vs
**Already in your library** from `duplicate`. **Open in Nexus** / **Open** /
**Done** emit `nexus-share://` URLs when `isShell`, and plain in-app links
otherwise (so `/share` is also coherent if opened in a normal browser).

Any capture-call failure produces a `{ ok: false }` result for that item; if
every item fails the card heading is **Couldn't save**. A failed result offers
card-level **Retry**. `ShareCapture` does not special-case HTTP `401` — the
session cookie is gated server-side in `page.tsx` (§6.5).

### 6.8 Middleware — `PUBLIC_ROUTES`

`apps/web/src/lib/supabase/middleware.ts` adds `"/share"` to the `PUBLIC_ROUTES`
set. `/share` is not "public" in the sense of unauthenticated data — it is a
route that renders its own session-aware UI in every state and must therefore
not be force-redirected to `/login`. This matches the other self-managing
entries already in the set (`/login`, `/auth/refresh`, `/extension/connect/start`).

### 6.9 Styles — `apps/web/src/app/share/share.module.css` (new)

Owns the compact surface: a centred card on a dimmed backdrop, sized for a phone,
honouring the warm-neutral palette and `prefers-reduced-motion`. Used by
`page.tsx` (backdrop, card, the inline sign-in-required card) and `ShareCapture`
— one owner of the share-card chrome.

## 7. Composition with other systems

| System | Touchpoint |
|---|---|
| `from_url` ingestion pipeline | Reused as-is via `POST /api/media/from-url`. URL classification (YouTube/X/PDF/EPUB/article), dedupe, default-library filing, worker enqueue — all unchanged. |
| Daily notes | Reused as-is via `POST /api/notes/daily/{date}/quick-capture`. |
| Capture client functions | `addMediaFromUrl`, `quickCaptureDailyNote` reused verbatim — the same functions `AddContentTray` calls. No new capture client. |
| `extractUrls` | Moved out of `AddContentTray.tsx` to the flat lib module `lib/extractUrls.ts`; `AddContentTray` becomes a consumer of the shared owner. |
| Auth | Reuses the Supabase cookie session, `readSupabaseSessionCookie`, and `proxyToFastAPI`'s inline refresh + CSRF Origin check. No new token, no new auth code. |
| Android shell | `ShareActivity` is a sibling of `MainActivity`; they share `NexusWebView` configuration only. `nexus-share://` is intercepted inside `ShareActivity`'s WebView; `nexus://auth/handoff` remains the registered auth return scheme. `MainActivity` is otherwise untouched. |
| `isAndroidShell` | `isAndroidShellUserAgent` (server-side) gates the `nexus-share://` action targets. The shell-detection owner (`androidShell.ts`) is unchanged. |
| Workspace / reader | `Open in Nexus` hands `MainActivity` a `/media/<id>` or `/daily` URL, which it opens as a pane through its existing routing. `/share` never touches the workspace store or pane system. |
| Command palette | None. "Share to Nexus" is an inbound OS feature; it adds no palette command. |
| Browser extension | None. The extension remains the desktop-browser capture path; the shared concept ("a non-tray capture trigger") is noted, not coupled. |

## 8. Rules and invariants

- **Hard cutover.** `MainActivity.hardenWebView` is deleted, replaced by
  `NexusWebView.configure`. `extractUrls` is deleted from `AddContentTray.tsx`,
  replaced by the `lib/extractUrls.ts` import. No feature flag, no compatibility
  shim, no dual path. The feature ships whole.
- **One owner.** WebView configuration → `NexusWebView`. URL extraction →
  `lib/extractUrls.ts`. The capture concern keeps its existing single owner;
  this feature adds a trigger, not a second capture path.
- **No new ingestion surface.** No API route, no server action, no FastAPI route,
  no database migration. The feature is a trigger and a confirmation UI.
- **No new environment variables and no new `BuildConfig` field**
  (`environment.md`). `ShareActivity` reuses `BuildConfig.NEXUS_BASE_URL`;
  `.env.example` is unchanged.
- **Exhaustive branching** (`control-flow.md`). `page.tsx`'s switch over the
  session four-state ends in a `never`/`satisfies` check.
- **`/share` mounts no app shell.** No navbar, workspace, command palette, or
  player. It renders only the compact card.
- **Named constants** — the `nexus-share` scheme and its hosts, the `/share`
  path. No magic strings or numbers (`conventions.md`).
- **Imports** rise at most two levels, else the `@/` alias (`codebase.md`).
- **Accessibility** — the card is reachable and operable; actions are real
  links/buttons; motion respects `prefers-reduced-motion`.
- **No PWA.** No web manifest, no service worker, no `share_target`. A PWA share
  target would be a *second* share-sheet entry competing with the native app —
  rejected (§10.1).

## 9. Final state

- `apps/android` declares `ShareActivity` with an `ACTION_SEND` / `text/plain`
  intent filter; Nexus appears in the Android system share sheet.
- `NexusWebView` is the sole owner of WebView configuration; `MainActivity` and
  `ShareActivity` both consume it; `MainActivity.hardenWebView` no longer exists.
- `apps/web/src/app/share/` contains `page.tsx`, `ShareCapture.tsx`, and
  `share.module.css`.
- `extractUrls` lives at `apps/web/src/lib/extractUrls.ts` (its only home);
  `AddContentTray.tsx` and `ShareCapture.tsx` import it from there.
- `/share` is in `PUBLIC_ROUTES`; it captures a shared URL or text and confirms,
  branching exhaustively on the session four-state.
- A user can share a link or text from any Android app into Nexus in two taps —
  the share sheet, then "Nexus" — and is returned to the source app.
- No API route, server action, FastAPI route, DB migration, env var, or
  `BuildConfig` field was added.

## 10. Key decisions

1. **Native `ACTION_SEND` filter, not a PWA `share_target`.** The
   textbook share-into route for a web app is a PWA manifest `share_target`. It
   is rejected: there is no PWA infrastructure (no manifest, service worker, or
   icons — all would be net-new), and, decisively, a PWA share target would
   *coexist* with the installed native app, putting **two** "Nexus" entries in
   the share sheet — a known, confusing UX. PWA share target is the right tool
   only with no native app, or for iOS/desktop reach; neither is in scope.
   Reconsider only if the native APK is ever retired.

2. **One capture path: WebView `/share`, not a native background POST.**
   A native fire-and-forget POST (toast, never leave the source app) is the
   "magical" pattern. It is rejected on `cleanliness.md`'s one-owner rule: it
   needs a second ingestion client, a new scoped-token type, native HTTP, native
   secure storage, and native error handling — a parallel capture stack. The
   WebView route reuses the in-app capture functions and cookie session
   verbatim. A ~1s confirmation card is the accepted cost.

3. **A separate `ShareActivity`, not `ACTION_SEND` on `MainActivity`.**
   `MainActivity` is `singleTask` and owns the live app. A separate activity in
   its own task captures and dies without perturbing the workspace or back-stack.

4. **`nexus-share://` URL scheme for the native hand-off**, matching the
   current native-owned custom-scheme pattern — no `addJavascriptInterface`,
   consistent with a shell that has no JS bridge, and a minimal two-signal
   surface.

5. **Logged-out is terminal; the share surface never hosts OAuth.** An OAuth
   callback is an App-Links `VIEW` intent bound to `MainActivity` and would
   abandon `ShareActivity`. A logged-out user re-shares after signing in. The
   case is near-zero frequency for an installed app, and the contract keeps a
   share from ever being trapped behind a login redirect.

6. **Capture to the default library; no per-share library picker.** Auto-firing
   the capture on mount is the speed win; a pre-capture picker defeats it and a
   post-capture move is a separate concern. The backend files `library_id`-less
   media in `Library.is_default` — the right default. Per-share library
   selection is a non-goal (§14).

7. **Shared files (PDF/EPUB) are out of scope.** A shared file arrives as a
   `content://` URI; capturing it would require native file-byte reading and a
   native upload — exactly the native-HTTP path decision 2 avoids. URLs and text
   are the overwhelming majority of share volume and need none of it. The
   backend already supports file capture (`/media/capture/file`); only the
   native glue is deferred.

8. **`text/plain` only.** URL and text shares are `text/plain` across Chrome, X,
   YouTube, Reddit, and the rest. Richer mime types are a non-goal.

## 11. Acceptance criteria

Share sheet & `ShareActivity`:

- [ ] With the app installed, sharing a link from Chrome lists "Nexus" in the
      system share sheet; so does sharing from the X app and the YouTube app.
- [ ] Choosing "Nexus" opens the compact `/share` card, not the full app.
- [ ] Sharing empty/whitespace text does not open a card; `ShareActivity`
      finishes silently.
- [ ] Dismissing the card returns the user to the app they shared from;
      `MainActivity`'s task and back-stack are unaffected.

The `/share` surface:

- [ ] Sharing an article URL captures it; the card shows the URL and **Saved**.
- [ ] Sharing the same URL again shows **Already in your library** (no duplicate).
- [ ] Sharing an X/Twitter post URL captures it as a readable same-author thread.
- [ ] Sharing a YouTube URL captures it as a video.
- [ ] Sharing plain text with no URL adds a bullet to today's daily note.
- [ ] Sharing text containing a URL captures the URL as media.
- [ ] Sharing several URLs at once captures each; a per-URL failure is shown with
      **Retry** while the others still succeed.
- [ ] **Open in Nexus** foregrounds the full app on the captured item; **Done**
      returns to the source app.
- [ ] A capture network failure shows a retryable error; **Retry** re-captures.

Authentication:

- [ ] With a signed-in session, capture proceeds with no login prompt.
- [ ] With an expired-but-refreshable session, capture still succeeds.
- [ ] With a fully ended session, the card shows "sign in required" and captures
      nothing; no OAuth flow starts inside the share surface.

Cutover & scope:

- [ ] `MainActivity.hardenWebView` no longer exists; `MainActivity` and
      `ShareActivity` both use `NexusWebView.configure`.
- [ ] `extractUrls` exists only in `lib/extractUrls.ts`; `AddContentTray`
      imports it and behaves unchanged.
- [ ] No API route, server action, FastAPI route, DB migration, env var, or
      `BuildConfig` field was added.
- [ ] `/share` mounts no navbar, workspace, command palette, or player.

## 12. Test plan

- `extractUrls.test.ts` (unit, Node) — direct coverage for the function in its
  new home `apps/web/src/lib/extractUrls.ts`: extraction, trailing-punctuation
  trim, dedupe, rejection of non-`http(s)` and unparseable URLs. This is the
  only unit test the feature adds; `ShareCapture` has no component test —
  exercising it would require mocking internal modules, which
  `docs/rules/testing_standards.md` forbids.
- `e2e/tests/share.spec.ts` (Playwright, real Next + FastAPI + Postgres) — the
  end-to-end coverage of `ShareCapture` and `page.tsx`. With an authenticated
  session: navigate to `/share?text=<plain text>` and assert the daily-note
  bullet (heading **Saved to Nexus**, **Added to today**, an **Open** link to
  `/daily`); navigate to `/share?text=<fresh URL>` and assert the saved media
  (**Saved**, an **Open in Nexus** link to `/media/…`). Unauthenticated (a
  cookie-less context): navigate to `/share?text=…` and assert the **Sign in to
  save this** card with no capture.
- `ShareActivityTest.kt` (Android instrumentation, `make test-android`) — an
  `ACTION_SEND` `text/plain` intent with non-empty `EXTRA_TEXT` keeps
  `ShareActivity` resumed; an empty `EXTRA_TEXT`, and an absent `EXTRA_TEXT`,
  each finish the activity immediately.
- Manual: a real device, sharing from Chrome, the X app, and the YouTube app;
  confirm the share-sheet entry, the capture, and return-to-caller across at
  least two OEM share-sheet implementations (§16).

Commands: `make check`, `make test-unit`, `make test`, `make test-e2e`,
`make test-android`, `make verify`.

## 13. Implementation phases

Each phase compiles and leaves the suite green. All phases land together on one
branch, `share-to-nexus` — no phase ships a lesser feature to `main`.

1. **Shared pure layer.** Move `extractUrls` to `apps/web/src/lib/extractUrls.ts`;
   update the `AddContentTray.tsx` import; add `extractUrls.test.ts`. No UI.
2. **The `/share` route.** `page.tsx` (with the inline sign-in-required card),
   `ShareCapture.tsx`, `share.module.css`; add `/share` to `PUBLIC_ROUTES`.
   Functional in a desktop browser at `/share?text=…`.
3. **The Android WebView-config owner.** Add `NexusWebView`; cut `MainActivity`
   over to it; delete `MainActivity.hardenWebView`. The app builds and behaves
   identically.
4. **`ShareActivity`.** Add `ShareActivity.kt`, the manifest `<activity>` +
   `ACTION_SEND` filter, and `nexus-share://` interception. Nexus appears in the
   share sheet; the end-to-end flow works.
5. **Tests & docs.** `e2e/tests/share.spec.ts`; `ShareActivityTest.kt`; update
   `docs/rules/codebase.md` to record `ShareActivity` and the `nexus-share://`
   scheme as Android module boundaries; a dead-code sweep; `make verify` and
   `make test-android` green.

## 14. Scope and non-goals

**In scope:** the `ACTION_SEND` `text/plain` share-sheet entry; `ShareActivity`;
the `NexusWebView` extraction and `MainActivity` cutover; the `nexus-share://`
scheme; the `/share` route and its compact card; capture of one or more shared
URLs and of shared plain text; the `extractUrls` move; the `PUBLIC_ROUTES`
entry; the tests and the `codebase.md` update.

**Non-goals:** a PWA / web-manifest `share_target` (§10.1); a native background
(toast-only) capture path (§10.2); shared **files** — PDF/EPUB/images via
`EXTRA_STREAM` and `ACTION_SEND_MULTIPLE` (§10.7); per-share library or tag
selection (§10.6); OAuth/login inside the share surface (§10.5); iOS; desktop
browsers (the existing extension's domain); Android Direct Share / sharing
shortcuts and pinned targets; an offline capture queue; a warmed/pre-rendered
WebView; editing or annotating the shared content before capture; any change to
`from_url`, `quick-capture`, the FastAPI layer, or the database.

## 15. Files

New:

- `apps/web/src/lib/extractUrls.ts`
- `apps/web/src/lib/extractUrls.test.ts`
- `apps/web/src/app/share/page.tsx`
- `apps/web/src/app/share/ShareCapture.tsx`
- `apps/web/src/app/share/share.module.css`
- `apps/android/app/src/main/java/app/nexus/android/NexusWebView.kt`
- `apps/android/app/src/main/java/app/nexus/android/ShareActivity.kt`
- `apps/android/app/src/androidTest/java/app/nexus/android/ShareActivityTest.kt`
- `e2e/tests/share.spec.ts`
- `docs/share-to-nexus.md` (this document)

Modified:

- `apps/web/src/components/AddContentTray.tsx` — delete the local `extractUrls`;
  import it from `@/lib/extractUrls`.
- `apps/web/src/lib/supabase/middleware.ts` — add `"/share"` to `PUBLIC_ROUTES`.
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt` — cut over
  to `NexusWebView.configure`; delete `hardenWebView` and the absorbed
  `setWebContentsDebuggingEnabled` / `setAcceptCookie` calls.
- `apps/android/app/src/main/AndroidManifest.xml` — the `ShareActivity`
  `<activity>` block.
- `docs/rules/codebase.md` — record `ShareActivity` and the `nexus-share://`
  scheme as Android module boundaries.

## 16. Risks

| Risk | Mitigation |
|---|---|
| `ShareActivity` cold-starts a fresh WebView, adding latency before the card paints. | `/share` is a minimal server-rendered route with no app shell; the card paints on first response. A warmed WebView is a non-goal — it trades statefulness for speed and is not worth the complexity for a transient surface. |
| Return-to-caller task behaviour varies across OEM share-sheet implementations. | `taskAffinity=""` + `excludeFromRecents="true"` + a standard launch mode is the isolated-task configuration; §12's manual pass verifies return-to-caller on at least two devices. |
| The shared text rides in a `?text=` query parameter and appears in standard request logs. | Accepted: it is the user's own content being saved to their own account, not a secret. |
| A logged-out user loses the pending share. | A deliberate, documented contract (§3.6, §10.5); near-zero frequency for an installed app; the alternative — OAuth inside `ShareActivity` — collides with App-Links callback routing. |
| `text/plain`-only misses apps that share a link as a non-text mime type. | Rare; `text/plain` covers the browsers and social apps that matter. Other mime types are an explicit non-goal, revisitable later. |
| The `nexus-share://` scheme could collide with another handler. | The scheme is app-internal, intercepted only inside `ShareActivity`'s own WebView, and never registered in any manifest `<intent-filter>` — there is no collision surface. |
