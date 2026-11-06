import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["test/unit/**/*.test.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					testTimeout: 120_000,
					hookTimeout: 120_000,
				},
			},
		],
	},
});
