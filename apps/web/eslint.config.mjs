import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import testingLibrary from "eslint-plugin-testing-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { rules: { "react/no-danger": "error" } },
  {
    files: ["**/components/HtmlRenderer.tsx"],
    rules: { "react/no-danger": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      ...testingLibrary.configs["flat/react"].rules,
      "testing-library/no-node-access": "warn",
    },
  },
];

export default eslintConfig;
