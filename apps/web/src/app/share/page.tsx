import { cookies, headers } from "next/headers";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import ShareCapture from "./ShareCapture";
import styles from "./share.module.css";

// The Android share-sheet capture surface. A compact card under the root
// layout — never the authenticated app shell — that captures the shared text
// on load. `verifySession` is deliberately not used: it redirects a logged-out
// viewer to `/login`, which would trap a share behind a login flow.
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
      // `refreshable` proceeds: the capture call refreshes the session inline.
      content = <ShareCapture text={sharedText} isShell={isShell} />;
      break;
    case "ended":
    case "anonymous":
      content = (
        <>
          <h1 className={styles.heading}>Sign in to save this</h1>
          <p className={styles.body}>
            Open Nexus, sign in, then share again to save this to your library.
          </p>
          <div className={styles.actions}>
            <a
              className={styles.actionPrimary}
              href={isShell ? "nexus-share://dismiss" : "/"}
            >
              Done
            </a>
          </div>
        </>
      );
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
