import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import testingLibrary from "eslint-plugin-testing-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "react/no-danger": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='setInterval']",
          message: "Product polling must go through useIntervalPoll.",
        },
        {
          // Canvas context properties are NOT part of the CSS cascade, so a
          // var(--…) string is unparseable and silently ignored (the assignment
          // is dropped). Resolve the design token via getComputedStyle, or
          // assign a literal value. (`el.style.font` is excluded — inline styles
          // do resolve var().)
          selector:
            "AssignmentExpression[left.property.name=/^(font|fillStyle|strokeStyle)$/][right.value=/var\\(--/]:not([left.object.property.name='style'])",
          message:
            "Canvas ctx.font/fillStyle/strokeStyle cannot resolve CSS custom properties; a var(--…) string is silently ignored. Resolve the token via getComputedStyle, or assign a literal value.",
        },
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
    // HtmlRenderer is the sole sanctioned sink for API-sanitized HTML.
    files: ["src/components/HtmlRenderer.tsx"],
    rules: { "react/no-danger": "off" },
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
