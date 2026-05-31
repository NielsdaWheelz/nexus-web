/**
 * API Keys management page (BYOK).
 *
 * Security constraints:
 * - Never console.log form state containing the api key.
 * - On submit success or failure, explicitly clear the input state.
 * - Mark input autoComplete="off".
 * - Never store api keys in localStorage.
 * - Key input value exists only in component state during form lifecycle.
 */

"use client";

import SettingsKeysPaneBody from "./SettingsKeysPaneBody";

export default function KeysPage() {
  return <SettingsKeysPaneBody />;
}
