import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const devPort = Number(process.env.REACTIVE_RESUME_DEV_PORT ?? 1420);

export default defineConfig({
	clearScreen: false,
	server: {
		host: "127.0.0.1",
		port: devPort,
		strictPort: true,
		fs: { allow: [repoRoot] },
	},
	envPrefix: ["VITE_", "TAURI_"],
	esbuild: { jsx: "automatic" },
	optimizeDeps: {
		exclude: ["@reactive-resume/pdf"],
	},
	plugins: [react()],
	build: {
		target: "es2022",
		sourcemap: true,
	},
});
