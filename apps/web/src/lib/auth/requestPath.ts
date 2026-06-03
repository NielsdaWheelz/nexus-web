// The header the Next.js middleware stamps on every protected request with its
// pathname+search, so server code (which cannot read the pathname natively) can
// recover it. Read by the auth DAL (redirect target) and the workspace bootstrap
// (initial pane href). The URL hash never reaches the server.
export const REQUEST_PATH_HEADER = "x-nexus-request-path";
