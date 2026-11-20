import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 5190 is the localhost origin the portal API's CORS allows on dev
// (backend/lib/portal-stack.ts portalOrigins), so it must not drift.
export default defineConfig({
  plugins: [react()],
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
});
