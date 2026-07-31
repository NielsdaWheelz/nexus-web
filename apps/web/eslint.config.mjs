import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import testingLibrary from "eslint-plugin-testing-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const NEXT_IMAGE_BAN = {
  name: "next/image",
  message:
    "Use <MediaImage> (src/components/ui/MediaImage.tsx); bare next/image is forbidden so the proxied-vs-owned/unoptimized invariant is enforced in one place.",
};

const KEYBOARD_INSET_BAN = {
  name: "@/lib/ui/useKeyboardInset",
  message:
    "Mobile modal keyboard geometry has one owner: useMobileModalLifecycle (src/components/ui/useMobileModalLifecycle.ts). Compose that lifecycle through a semantic mobile modal primitive instead of reading visual-viewport geometry directly (docs/cutovers/mobile-nexus-full-screen-task-hard-cutover.md).",
};

const PRODUCT_POLLING_BAN = {
  selector: "CallExpression[callee.name='setInterval']",
  message: "Product polling must go through useIntervalPoll.",
};

const CANVAS_CSS_VARIABLE_BAN = {
  // Canvas context properties are NOT part of the CSS cascade, so a
  // var(--…) string is unparseable and silently ignored (the assignment
  // is dropped). Resolve the design token via getComputedStyle, or
  // assign a literal value. (`el.style.font` is excluded — inline styles
  // do resolve var().)
  selector:
    "AssignmentExpression[left.property.name=/^(font|fillStyle|strokeStyle)$/][right.value=/var\\(--/]:not([left.object.property.name='style'])",
  message:
    "Canvas ctx.font/fillStyle/strokeStyle cannot resolve CSS custom properties; a var(--…) string is silently ignored. Resolve the token via getComputedStyle, or assign a literal value.",
};

const READER_SCROLL_MUTATION_BANS = [
  {
    selector:
      "AssignmentExpression[left.type='MemberExpression'][left.property.name='scrollTop']",
    message:
      "Reader scrollTop writes belong in src/lib/reader/paneScroll.ts and must use ReaderScrollPositioner.",
  },
  {
    selector:
      "AssignmentExpression[left.type='MemberExpression'][left.computed=true][left.property.value='scrollTop']",
    message:
      "Reader scrollTop writes belong in src/lib/reader/paneScroll.ts and must use ReaderScrollPositioner.",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(scrollTo|scrollIntoView)$/]",
    message:
      "Reader scrollTo and scrollIntoView calls belong in src/lib/reader/paneScroll.ts and must use ReaderScrollPositioner.",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.value=/^(scrollTo|scrollIntoView)$/]",
    message:
      "Reader scrollTo and scrollIntoView calls belong in src/lib/reader/paneScroll.ts and must use ReaderScrollPositioner.",
  },
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "react/no-danger": "error",
      "no-restricted-syntax": [
        "error",
        PRODUCT_POLLING_BAN,
        CANVAS_CSS_VARIABLE_BAN,
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/lib/useIntervalPoll.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: [
      "src/app/**/media/**/*.{ts,tsx}",
      "src/components/HtmlRenderer.tsx",
      "src/components/PdfReader.tsx",
      "src/components/pdfPaneFind.ts",
      "src/lib/reader/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}", "src/lib/reader/paneScroll.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        PRODUCT_POLLING_BAN,
        CANVAS_CSS_VARIABLE_BAN,
        ...READER_SCROLL_MUTATION_BANS,
      ],
    },
  },
  {
    // HtmlRenderer is the sole sanctioned sink for API-sanitized HTML.
    files: ["src/components/HtmlRenderer.tsx"],
    rules: { "react/no-danger": "off" },
  },
  {
    // R1 (docs/cutovers/oracle-plate-owned-asset-cutover.md): MediaImage is the
    // sole sanctioned importer of next/image. Banning the bare import everywhere
    // else keeps the proxied-vs-owned + `unoptimized` decision in one place.
    // AC-12 (docs/cutovers/mobile-nexus-full-screen-task-hard-cutover.md):
    // useMobileModalLifecycle is likewise the sole sanctioned production
    // importer of useKeyboardInset.
    // no-restricted-imports replaces (not merges) per file, so each sanctioned
    // importer gets a follow-up block restating the ban that still applies to it.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NEXT_IMAGE_BAN, KEYBOARD_INSET_BAN],
        },
      ],
    },
  },
  {
    files: ["src/components/ui/MediaImage.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [KEYBOARD_INSET_BAN],
        },
      ],
    },
  },
  {
    files: [
      "src/components/ui/useMobileModalLifecycle.ts",
      "src/lib/ui/useKeyboardInset.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NEXT_IMAGE_BAN],
        },
      ],
    },
  },
  {
    // R4 (docs/cutovers/authenticated-shell-first-paint-and-pane-splitting.md):
    // the always-loaded shell must never statically import a pane body, or pane
    // code (markdown, ProseMirror, the reader stack) lands in first-load JS.
    // Pane bodies are reached only through the lazy paneRenderRegistry.
    files: [
      "src/components/appnav/**",
      "src/components/launcher/Launcher.tsx",
      "src/components/launcher/useLauncherController.ts",
      "src/components/workspace/WorkspacePaneStrip.tsx",
      "src/lib/panes/paneLinkNavigation.ts",
      "src/lib/panes/paneRouteTable.ts",
      "src/lib/workspace/store.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NEXT_IMAGE_BAN, KEYBOARD_INSET_BAN],
          patterns: [
            {
              group: ["@/app/**/*PaneBody", "@/components/chat/Conversation"],
              message:
                "Shell modules must not import pane bodies — reach panes via the lazy paneRenderRegistry so pane code stays out of first-load JS.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      ...testingLibrary.configs["flat/react"].rules,
      "testing-library/no-node-access": "error",
    },
  },
];

export default eslintConfig;
