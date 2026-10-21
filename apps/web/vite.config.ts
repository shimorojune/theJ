import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  envDir: "../..",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.svg"],
      manifest: {
        name: "theJ",
        short_name: "theJ",
        description: "Your party DJ",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#0B0B0C",
        background_color: "#0B0B0C",
        start_url: "/",
        icons: [{ src: "logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        // Cache the app shell only. Audio streams from the api with range requests and is never precached.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    proxy: { "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
