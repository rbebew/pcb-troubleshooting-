import { defineConfig } from "vite";

// Byggets version (tidspunkt). Appen sammenligner den med version.json for at opdage nye versioner.
const buildId = new Date().toISOString().slice(0, 16).replace("T", " ");

// Relativ base, så appen virker både på GitHub Pages (/repo-navn/) og lokalt.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    {
      name: "version-file",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: buildId }) });
      },
    },
  ],
});
