import type { MediaNavigation, ReaderNavigationTocNode } from "@/lib/media/readerNavigation";
import type { ReaderSourceIssue } from "@/lib/media/readerSourceIssues";
import styles from "./readerSourceIssuesNotice.module.css";

export default function ReaderSourceIssuesNotice({
  issues,
  navigation,
  readable,
}: {
  readonly issues: readonly ReaderSourceIssue[];
  readonly navigation?: MediaNavigation;
  readonly readable: boolean;
}) {
  if (issues.length === 0) return null;

  const imageCount = issues.filter((issue) => issue.kind === "MissingImage").length;
  const navigationCount = issues.length - imageCount;
  const fragmentNumbers = new Map(
    navigation?.fragments.map((fragment) => [fragment.fragment_id, fragment.fragment_idx + 1]) ?? [],
  );
  const labels = new Map<string, string>();
  const collectLabels = (nodes: readonly ReaderNavigationTocNode[]) => {
    for (const node of nodes) {
      labels.set(node.id, node.label);
      collectLabels(node.children);
    }
  };
  if (navigation !== undefined) {
    collectLabels(navigation.toc_nodes);
    for (const location of [...navigation.landmarks, ...navigation.page_list]) {
      labels.set(location.id, location.label);
    }
  }

  return (
    <aside className={styles.notice} aria-label="Source issues">
      <strong>{readable ? "Readable with issues" : "Recorded source issues"}</strong>
      {imageCount > 0 ? (
        <p>
          {imageCount === 1 ? "One image reference is unavailable." : `${imageCount} image references are unavailable.`}
          {readable ? " You can read the available text." : null}
        </p>
      ) : null}
      {navigationCount > 0 ? (
        <p>
          {navigationCount === 1 ? "One contents link is unavailable." : `${navigationCount} contents links are unavailable.`}
          {readable ? " You can still read the book in order." : null}
        </p>
      ) : null}
      <details>
        <summary>Issue details ({issues.length})</summary>
        <ol className={styles.issues}>
          {issues.map((issue, index) => (
            <li key={index}>
              {issue.kind === "MissingImage" ? (
                <>
                  Image in {fragmentNumbers.get(issue.fragment_id) === undefined
                    ? `fragment ${issue.fragment_id}`
                    : `reading unit ${fragmentNumbers.get(issue.fragment_id)}`}:
                  {" "}image {issue.marker_ordinal + 1}: <code>{issue.resource_path}</code>
                </>
              ) : (
                <>
                  Contents link {labels.get(issue.node_id) ?? issue.node_id}:
                  {" "}<code>{issue.href}</code>
                </>
              )}
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}
