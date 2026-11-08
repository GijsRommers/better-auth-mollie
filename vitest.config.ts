import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					globalSetup: ["./test/helpers/prisma-setup.ts"],
					maxWorkers:
						process.env.TEST_DATABASE === "postgres" || process.env.TEST_DATABASE === "mysql"
							? 2
							: undefined,
					include: ["test/unit/**/*.test.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "prisma-mysql-contract",
					include: ["test/diagnostic/prisma-mysql.test.ts"],
					globalSetup: ["./test/helpers/prisma-setup.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					testTimeout: 240_000,
					hookTimeout: 120_000,
				},
			},
		],
	},
});
