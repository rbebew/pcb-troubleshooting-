import { defineConfig } from "vite";

// Relativ base, så appen virker både på GitHub Pages (/repo-navn/) og lokalt.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
