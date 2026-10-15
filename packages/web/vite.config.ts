import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Excalidraw reads this at runtime; Vite has no `process`.
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  server: { port: 5180, strictPort: true, host: "127.0.0.1" },
  preview: { port: 5181 },
});
