import { fileURLToPath } from "node:url";
// @boundaries-ignore root shared Vitest config
import { createVitestProjectConfig } from "../../vitest.shared.mts";

const config = createVitestProjectConfig({
	name: "desktop",
	dirname: fileURLToPath(new URL(".", import.meta.url)),
});

export default {
	...config,
	test: {
		...config.test,
		testTimeout: 720_000,
		hookTimeout: 30_000,
		pool: "forks",
		fileParallelism: false,
	},
};
