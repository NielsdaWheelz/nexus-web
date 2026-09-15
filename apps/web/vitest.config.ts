import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN": JSON.stringify(
      "http://localhost:3000",
    ),
  },
  test: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    environment: "node",
    include: ["src/**/*.unit.test.{ts,tsx}"],
    retry: 0,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
