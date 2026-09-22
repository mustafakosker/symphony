import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.SYMPHONY_API_PORT ?? "4317"}`, changeOrigin: false } },
  },
  test: {
    exclude: [...configDefaults.exclude, ".superpowers/**", ".symphony-local/**", "dist-server/**"],
  },
});
