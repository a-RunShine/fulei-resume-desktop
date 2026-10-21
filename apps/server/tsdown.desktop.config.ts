import { defineConfig } from "tsdown";
import { desktopServerDependencyStaysExternal } from "./src/desktop-bundle.ts";
import baseConfig from "./tsdown.config.ts";

const base = baseConfig as { plugins?: unknown[] };

export default defineConfig({
	...base,
	entry: {
		index: "src/index.ts",
		"desktop-host": "src/desktop-host.ts",
	},
	deps: {
		neverBundle: (id: string) => desktopServerDependencyStaysExternal(id),
		alwaysBundle: (id: string) =>
			id.startsWith("@reactive-resume/") || id.replaceAll("\\", "/").includes("/@reactive-resume/"),
	},
});
