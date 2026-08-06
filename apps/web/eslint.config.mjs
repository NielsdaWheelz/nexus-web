import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import playwright from "eslint-plugin-playwright";
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

const OWNED_MODULE_MOCK_BANS = [
  {
    selector:
      "CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock)$/] > Literal:first-child[value=/^(?:@\\/|\\.\\.?\\/)/]",
    message:
      "Do not mock Nexus modules. Exercise the owned implementation and stub only an external boundary.",
  },
  {
    // A backtick path is a one-character escape from the Literal ban above, and
    // vi.doMock honors any static string at runtime — so a no-substitution
    // template literal must be rejected identically.
    selector:
      "CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock)$/] > TemplateLiteral:first-child[expressions.length=0][quasis.0.value.cooked=/^(?:@\\/|\\.\\.?\\/)/]",
    message:
      "Do not mock Nexus modules. Exercise the owned implementation and stub only an external boundary.",
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name='spyOn']",
    message:
      "Do not spy on owned behavior. Assert the product result at its real boundary.",
  },
];

const FAKE_TIMER_BAN = {
  selector:
    "CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(useFakeTimers|useRealTimers|setSystemTime|advanceTimersByTime|advanceTimersByTimeAsync|advanceTimersToNextFrame|advanceTimersToNextTimer|advanceTimersToNextTimerAsync|clearAllTimers|runAllTimers|runAllTimersAsync|runOnlyPendingTimers|runOnlyPendingTimersAsync)$/]",
  message:
    "Do not use fake timers. Drive the owned state transition or inject the external clock boundary.",
};

const SLEEP_BANS = [
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message: "Do not sleep in tests. Await an observable state transition.",
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(globalThis|window)$/][callee.property.name='setTimeout']",
    message: "Do not sleep in tests. Await an observable state transition.",
  },
];

const DISABLED_TEST_BAN = {
  selector: "MemberExpression[property.name=/^(skip|skipIf|runIf|only|todo)$/]",
  message:
    "Tests must run exactly as collected; conditional collection, skip, only, and todo are forbidden.",
};

const VACUOUS_TEST_BANS = [
  {
    selector:
      "CallExpression[callee.name=/^(test|it)$/] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
    message: "A test callback must execute an observable proof.",
  },
  {
    selector: "CallExpression[callee.name='expect'] > Literal:first-child",
    message: "Do not assert a literal. Assert behavior observed from the system under test.",
  },
];

const PLAYWRIGHT_ROUTE_BANS = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(route|routeFromHAR)$/]",
    message:
      "Journey files cannot intercept routes. Use the harness allowlist or a real external-boundary fixture.",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(fulfill|fallback)$/]",
    message:
      "Journey files cannot fulfill intercepted routes. Use a real external-boundary fixture.",
  },
];

const PLAYWRIGHT_RAW_REQUEST_BANS = [
  {
    selector:
      "ImportDeclaration[source.value=/^(?:@playwright\\/test|playwright\\/test)$/] > ImportSpecifier[imported.name=/^(?:request|APIRequestContext)$/]",
    message:
      "Raw Playwright API requests belong only to e2e/request.ts. Import the harness-owned request facade.",
  },
  {
    selector:
      "MemberExpression[property.name='request']:not([object.name='route'])",
    message:
      "Do not use page.request or context.request. Use the origin-validating e2e/request.ts facade.",
  },
  {
    selector: "ObjectPattern > Property[key.name='request']",
    message:
      "Do not use Playwright's raw request fixture. Use the origin-validating e2e/request.ts facade.",
  },
];

const PLAYWRIGHT_RETRY_AND_WORKER_BANS = [
  {
    selector:
      "Property[key.name='retries']:not([value.type='Literal'][value.value=0])",
    message: "Playwright retries must be the literal value 0.",
  },
  {
    selector:
      "Property[key.name='workers']:not([value.type='Literal'][value.value=1])",
    message: "Playwright workers must be the literal value 1.",
  },
];

const VITEST_RETRY_AND_WORKER_BANS = [
  {
    selector: "Property[key.name='retry']:not([value.type='Literal'][value.value=0])",
    message: "Vitest retries must be the literal value 0.",
  },
  {
    selector:
      "Property[key.name='maxWorkers']:not([value.type='Literal'][value.value=1])",
    message: "Vitest maxWorkers must be the literal value 1.",
  },
];

const UNIT_AND_BROWSER_TESTS = [
  "src/**/*.unit.test.{ts,tsx}",
  "src/**/*.browser.test.{ts,tsx}",
];

const PLAYWRIGHT_TESTS = ["e2e/**/*.{ts,tsx,mjs}"];

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

// docs/cutovers/canonical-resource-action-menu-hard-cutover.md (AC12 — strict
// residue). Resource-action membership, presentation, execution, and state have
// exactly one owner: the pure resolveResourceActionPlan over
// RESOURCE_ACTION_CATALOG, rendered by ResourceActionMenu and executed by the
// resourceActionRuntime. The projection, caller-published resource groups,
// duplicate NexusAction adapters, and surface-local option builders were
// deleted; naming any of them in product source is a residue.
const RETIRED_RESOURCE_ACTION_SYMBOL_BAN = {
  selector:
    "Identifier[name=/^(?:composeResourceMenu|ResourceMenuGroups|emptyResourceMenuGroups|RichResourceActionGroups|ActionPublication|publishResourceRowActions|resolveResourceCoreActions|resolveResourceCoreCatalogKeys|resolveUniversalResourceRelationshipActions|ResourceActionProjection|buildResourceNexusActions|mediaResourceOptions|episodeResourceOptions|libraryResourceOptions|podcastResourceOptions|conversationResourceOptions)$/]",
  message:
    "Retired resource-action symbol. Membership, presentation, and execution have one owner: resolveResourceActionPlan over RESOURCE_ACTION_CATALOG, rendered by ResourceActionMenu and executed by the resourceActionRuntime. Do not reintroduce the projection, caller-published groups, NexusAction adapters, or surface-local option builders (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).",
};

// queue-add and the player-local Player.Open* ids left the resource system. Ban
// both the string literal and the no-substitution template literal (a backtick
// is a one-character escape from the Literal ban), mirroring the double selector
// in OWNED_MODULE_MOCK_BANS. The pattern is anchored so ids still in use are safe.
const RETIRED_PLAYER_RESOURCE_ID_MESSAGE =
  "Retired resource-action id. queue-add and the player-local Player.OpenTrack / Player.OpenSource ids left the resource system; the canonical Open action and Lectern relationship live in RESOURCE_ACTION_CATALOG and render through ResourceActionMenu (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).";
const RETIRED_PLAYER_RESOURCE_ID_BANS = [
  {
    selector:
      "Literal[value=/^(?:queue-add|Player\\.OpenTrack|Player\\.OpenSource)$/]",
    message: RETIRED_PLAYER_RESOURCE_ID_MESSAGE,
  },
  {
    selector:
      "TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/^(?:queue-add|Player\\.OpenTrack|Player\\.OpenSource)$/]",
    message: RETIRED_PLAYER_RESOURCE_ID_MESSAGE,
  },
];

// Context-edge and connection commands are not resource actions; they publish
// through the separate ContextEdgeMenu contract. Ban the literal and template
// forms of the retired ids.
const RETIRED_CONTEXT_EDGE_RESOURCE_ID_MESSAGE =
  "Retired resource-action id. Context-edge and connection commands (RelationshipAction.Context.* / RelationshipAction.Connection.*) are not resource actions; they publish through the separate ContextEdgeMenu contract (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).";
const RETIRED_CONTEXT_EDGE_RESOURCE_ID_BANS = [
  {
    selector:
      "Literal[value=/^(?:RelationshipAction\\.Context\\.Remove|RelationshipAction\\.Connection\\.Unlink|RelationshipAction\\.Connection\\.Dismiss)$/]",
    message: RETIRED_CONTEXT_EDGE_RESOURCE_ID_MESSAGE,
  },
  {
    selector:
      "TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/^(?:RelationshipAction\\.Context\\.Remove|RelationshipAction\\.Connection\\.Unlink|RelationshipAction\\.Connection\\.Dismiss)$/]",
    message: RETIRED_CONTEXT_EDGE_RESOURCE_ID_MESSAGE,
  },
];

const RETIRED_CANONICAL_RESOURCE_ACTION_PATH_MESSAGE =
  "Retired canonical resource-action path. Use the retained subject cache, pure planner, typed runtime, and ResourceActionMenu; do not restore duplicate projection, invalidation, surface execution, busy, or Highlight builders (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).";
const RETIRED_CANONICAL_RESOURCE_ACTION_PATH_BAN = {
  selector:
    "Identifier[name=/^(?:useResourceActionCatalogProjection|publishResourceActionSnapshotInvalidation|useDocumentActions|episodeActionBusyKey|buildHighlightActions)$/]",
  message: RETIRED_CANONICAL_RESOURCE_ACTION_PATH_MESSAGE,
};

const RETIRED_SURFACE_LOCAL_RESOURCE_ACTION_ID_MESSAGE =
  "Retired surface-local resource-action id. Publish the canonical action subject and let RESOURCE_ACTION_CATALOG own the stable ID (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).";
const RETIRED_SURFACE_LOCAL_RESOURCE_ACTION_ID_BANS = [
  {
    selector:
      "Literal[value=/^(?:ViewAction\\.Episode\\.(?:PlayNext|Transcript)|Author\\.Rename|Player\\.(?:OpenPreview|PreviewSource))$/]",
    message: RETIRED_SURFACE_LOCAL_RESOURCE_ACTION_ID_MESSAGE,
  },
  {
    selector:
      "TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/^(?:ViewAction\\.Episode\\.(?:PlayNext|Transcript)|Author\\.Rename|Player\\.(?:OpenPreview|PreviewSource))$/]",
    message: RETIRED_SURFACE_LOCAL_RESOURCE_ACTION_ID_MESSAGE,
  },
];

const RETIRED_RESOURCE_ACTION_MENU_TARGET_PROP_BAN = {
  selector:
    "JSXOpeningElement[name.name='ResourceActionMenu'] > JSXAttribute[name.name='target']",
  message:
    "ResourceActionMenu accepts actionSubject only. Activation and surface policy belong to the canonical snapshot (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).",
};

const RETIRED_RESOURCE_ACTION_BANS = [
  RETIRED_RESOURCE_ACTION_SYMBOL_BAN,
  ...RETIRED_PLAYER_RESOURCE_ID_BANS,
  ...RETIRED_CONTEXT_EDGE_RESOURCE_ID_BANS,
  RETIRED_CANONICAL_RESOURCE_ACTION_PATH_BAN,
  ...RETIRED_SURFACE_LOCAL_RESOURCE_ACTION_ID_BANS,
  RETIRED_RESOURCE_ACTION_MENU_TARGET_PROP_BAN,
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
    // docs/cutovers/canonical-resource-action-menu-hard-cutover.md (AC12). The
    // retired resource-action symbols and ids are banned across product source.
    // Tests are excluded because residue proofs legitimately name the deleted
    // ids in negative assertions. no-restricted-syntax replaces (not merges),
    // so this block restates the always-on product bans it augments. It precedes
    // the useIntervalPoll and reader blocks so their later overrides still win
    // (the reader block re-adds these residue bans).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        PRODUCT_POLLING_BAN,
        CANVAS_CSS_VARIABLE_BAN,
        ...RETIRED_RESOURCE_ACTION_BANS,
      ],
    },
  },
  {
    // The sole setInterval owner is exempt ONLY from PRODUCT_POLLING_BAN; the
    // residue + canvas bans still apply (no-restricted-syntax replaces).
    files: ["src/lib/useIntervalPoll.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        CANVAS_CSS_VARIABLE_BAN,
        ...RETIRED_RESOURCE_ACTION_BANS,
      ],
    },
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
        ...RETIRED_RESOURCE_ACTION_BANS,
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
  {
    files: UNIT_AND_BROWSER_TESTS,
    rules: {
      "no-restricted-syntax": [
        "error",
        PRODUCT_POLLING_BAN,
        CANVAS_CSS_VARIABLE_BAN,
        ...OWNED_MODULE_MOCK_BANS,
        ...VACUOUS_TEST_BANS,
        FAKE_TIMER_BAN,
        ...SLEEP_BANS,
        DISABLED_TEST_BAN,
      ],
    },
  },
  {
    files: ["vitest.browser-setup.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...OWNED_MODULE_MOCK_BANS],
    },
  },
  {
    files: ["vitest.config.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...VITEST_RETRY_AND_WORKER_BANS],
    },
  },
  {
    ...playwright.configs["flat/recommended"],
    files: PLAYWRIGHT_TESTS,
    rules: {
      ...playwright.configs["flat/recommended"].rules,
      "playwright/no-focused-test": "error",
      "playwright/no-raw-locators": "error",
      "playwright/no-skipped-test": "error",
      "playwright/no-slowed-test": "error",
      "playwright/no-wait-for-timeout": "error",
      "playwright/prefer-web-first-assertions": "error",
      "no-restricted-syntax": [
        "error",
        ...PLAYWRIGHT_RETRY_AND_WORKER_BANS,
        ...OWNED_MODULE_MOCK_BANS,
        ...VACUOUS_TEST_BANS,
        FAKE_TIMER_BAN,
        ...SLEEP_BANS,
        DISABLED_TEST_BAN,
        ...PLAYWRIGHT_RAW_REQUEST_BANS,
      ],
    },
  },
  {
    files: ["e2e/{journeys,extension}/**/*.{ts,tsx,mjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...PLAYWRIGHT_RETRY_AND_WORKER_BANS,
        ...OWNED_MODULE_MOCK_BANS,
        ...VACUOUS_TEST_BANS,
        FAKE_TIMER_BAN,
        ...SLEEP_BANS,
        DISABLED_TEST_BAN,
        ...PLAYWRIGHT_RAW_REQUEST_BANS,
        ...PLAYWRIGHT_ROUTE_BANS,
      ],
    },
  },
  {
    files: ["e2e/request.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...PLAYWRIGHT_RETRY_AND_WORKER_BANS,
        ...OWNED_MODULE_MOCK_BANS,
        FAKE_TIMER_BAN,
        ...SLEEP_BANS,
        DISABLED_TEST_BAN,
      ],
    },
  },
];

export default eslintConfig;
