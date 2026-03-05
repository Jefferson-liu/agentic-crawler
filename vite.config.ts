import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "client",
  server: {
    proxy: {
      "/api": "http://localhost:4111",
      "/ws": {
        target: "ws://localhost:4111",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist",
  },
});
