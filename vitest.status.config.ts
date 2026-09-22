import { defineConfig } from "vitest/config";

// Keep imported narumitw suites isolated from the other packages' own runners.
export default defineConfig({
	test: {
		environment: "node",
		include: [
			"packages/pi-usage/test/**/*.test.ts",
			"packages/pi-statusline/test/**/*.test.ts",
			"packages/pi-tui-kit/test/**/*.test.ts",
			"test/usage-statusline.integration.test.ts",
		],
		globalSetup: ["./test/vitest.global-setup.ts"],
		setupFiles: ["./test/vitest.setup.ts"],
		runner: "./test/vitest.runner.ts",
		pool: "forks",
		testTimeout: 5_000,
		hookTimeout: 30_000,
		teardownTimeout: 10_000,
	},
});
