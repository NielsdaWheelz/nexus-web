import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const directory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: directory });

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
    },
  },
  {
    // The reader primitive is free of hosted modules: hosts plug in through its ports.
    files: ["src/lib/documentReader/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
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
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/HtmlRenderer.tsx"],
    rules: {
      "react/no-danger": "off",
    },
  },
];
