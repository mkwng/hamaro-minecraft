import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dist/ is COMMITTED to git on purpose: if this toolchain won't build in 2036,
// the deployable site still lives in the repo (see docs/RUNBOOK.md).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", sourcemap: false },
});
