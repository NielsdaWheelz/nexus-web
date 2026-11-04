import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const directory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: directory });

// Flat config replaces a rule's options wholesale in a later block, so a block that
// sets no-restricted-imports or no-restricted-syntax for its files spreads these
// lists into its own, or it silently drops the bans for those files.
const LUCIDE_MESSAGE = "draw a sign from lib/ui/icons.tsx, the one importer of lucide.";
const LUCIDE_PATHS = [{ name: "lucide-react", message: LUCIDE_MESSAGE }];
const LUCIDE_PATTERNS = [{ group: ["lucide-react/*"], message: LUCIDE_MESSAGE }];

const SYNTAX = [
  {
    selector:
      "ImportDeclaration[source.value='@/lib/ui/icons'] > :matches(ImportSpecifier, ImportDefaultSpecifier, ImportNamespaceSpecifier[local.name!='Icon'])",
    message: "import the registry as `* as Icon`: a consumer names a sign and never renames one.",
  },
  {
    selector: "MemberExpression[computed=true][object.name='Icon']",
    message: "name the sign, `Icon.Dismiss`: computed access hides which signs ship.",
  },
  {
    selector:
      ":matches(ImportExpression, TSImportType):matches([source.value=/^lucide-react/], [source.value='@/lib/ui/icons'])",
    message: "glyphs load statically, through `import * as Icon`.",
  },
  {
    // A fail title is its second argument; a compound local kind tag is not copy.
    // A say line carries its fact in the first argument.
    selector: [
      "CallExpression:matches([callee.name='fail'], [callee.property.name='fail']) > :matches(Literal[value=/^[A-Z]/][value!=/^([A-Z][a-z]+){2,}$/], TemplateLiteral[quasis.0.value.raw=/^[A-Z]/]):nth-child(2)",
      "CallExpression:matches([callee.name='say'], [callee.property.name='say']) > :matches(Literal[value=/^[A-Z]/], TemplateLiteral[quasis.0.value.raw=/^[A-Z]/]):first-child",
      "CallExpression:matches([callee.name='say'], [callee.property.name='say']) > ObjectExpression.arguments:first-child > Property[key.name='fact'] > :matches(Literal[value=/^[A-Z]/], TemplateLiteral[quasis.0.value.raw=/^[A-Z]/])",
    ].join(", "),
    message: "a feedback fact is lowercase, except a user's own titles and names.",
  },
];

// Brand and data marks draw raw svg in their owners; a glyph never does.
const RAW_DRAWING_SYNTAX = [
  {
    selector: "JSXOpeningElement[name.name='svg']",
    message: "a glyph is a sign from lib/ui/icons.tsx; raw svg belongs to the brand and data mark owners.",
  },
  {
    selector: ":matches(JSXAttribute[name.name='strokeWidth'], Property[key.name='strokeWidth'])",
    message: "every glyph draws at --icon-stroke; a declared exception sets its weight in its own css.",
  },
];

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "public/pdfjs/**", "src/lib/api/wire.gen.ts"],
  },
  {
    rules: {
      "react/no-danger": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { paths: LUCIDE_PATHS, patterns: LUCIDE_PATTERNS }],
      "no-restricted-syntax": ["error", ...SYNTAX, ...RAW_DRAWING_SYNTAX],
    },
  },
  {
    files: [
      "src/components/ui/ActionMenu.tsx",
      "src/components/ui/PickerSurface.tsx",
      "src/components/ui/ChoicePicker.tsx",
      "src/components/ui/HoverPreview.tsx",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: LUCIDE_PATHS,
        patterns: [...LUCIDE_PATTERNS, {
          group: ["@/components/feedback", "@/components/feedback/**", "**/feedback", "**/feedback/**"],
          message: "this surface holds verbs, options and their row marks; its host owns feedback.",
        }],
      }],
    },
  },
  {
    // The reader primitive is free of hosted modules: hosts plug in through its ports.
    files: ["src/lib/documentReader/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: LUCIDE_PATHS,
          patterns: [
            {
              group: [
                "@/app/*",
                "@/lib/api/client",
                "@/lib/auth/*",
                "@/lib/panes/*",
                "@/lib/workspace/*",
              ],
              message:
                "lib/documentReader is free of hosted modules: a host plugs in through its ports.",
            },
            ...LUCIDE_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/app/opengraph-image.tsx",
      "src/app/apple-icon.tsx",
      "src/app/login/LoginPageClient.tsx",
      "src/app/(authenticated)/oracle/ornaments.tsx",
      "src/app/(authenticated)/stats/StatsPaneBody.tsx",
      "src/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody.tsx",
      "src/components/AsterismMark.tsx",
      "src/components/media/MediaIdentity.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX],
    },
  },
  {
    files: ["src/lib/ui/icons.tsx"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["src/components/HtmlRenderer.tsx"],
    rules: {
      "react/no-danger": "off",
    },
  },
];
