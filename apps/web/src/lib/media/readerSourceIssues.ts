export type ReaderSourceIssue =
  | {
      readonly kind: "MissingImage";
      readonly fragment_id: string;
      readonly marker_ordinal: number;
      readonly resource_path: string;
    }
  | {
      readonly kind: "UnresolvedNavigationTarget";
      readonly node_id: string;
      readonly href: string;
    };
