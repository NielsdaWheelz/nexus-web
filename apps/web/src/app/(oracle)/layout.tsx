import type { ReactNode } from "react";
import {
  EB_Garamond,
  IM_Fell_English,
  UnifrakturMaguntia,
} from "next/font/google";
import { verifySession } from "@/lib/auth/dal";
import OracleShell from "./OracleShell";

// The Black Forest Oracle theme's fonts live with the route group that owns
// them. Declaring them here (rather than in the root layout) scopes next/font's
// preload to /oracle routes only — where they are render-critical — instead of
// preloading them on every page in the app, which triggered "preloaded but not
// used" warnings everywhere else. They back --font-oracle-* (see globals.css,
// [data-theme="oracle"]).
const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-eb-garamond",
});

const imFellEnglish = IM_Fell_English({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-im-fell",
});

const unifrakturMaguntia = UnifrakturMaguntia({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  variable: "--font-unifraktur",
});

export default async function OracleLayout({
  children,
}: {
  children: ReactNode;
}) {
  await verifySession();
  // Single scope boundary for the whole oracle sub-app: it declares the theme
  // (data-theme="oracle") and defines the oracle font CSS variables once, for
  // everything below — the shell chrome (header) and every page surface alike.
  // Because [data-theme="oracle"] in globals.css only sets custom properties
  // (no element-targeted styles, no descendant combinators), descendants pick
  // up the theme purely by inheritance, so no surface needs to re-declare it.
  // display: contents keeps this wrapper out of the layout/scroll box model, so
  // the height chain from <body> is unchanged.
  return (
    <div
      data-theme="oracle"
      style={{ display: "contents" }}
      className={`${ebGaramond.variable} ${imFellEnglish.variable} ${unifrakturMaguntia.variable}`}
    >
      <OracleShell>{children}</OracleShell>
    </div>
  );
}
