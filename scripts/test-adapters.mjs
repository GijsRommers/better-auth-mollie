import { spawnSync } from "node:child_process";

for (const database of ["sqlite", "postgres", "mysql"]) {
	for (const adapter of ["kysely", "drizzle", "prisma"]) {
		if (database === "mysql" && adapter === "prisma") {
			console.log(
				"Skipping unsupported Prisma 6/MySQL billing; run pnpm test:prisma-mysql-contract for the known incompatibility.",
			);
			continue;
		}
		console.log(`\nTesting ${adapter} / ${database}`);
		const result = spawnSync("pnpm", ["test"], {
			stdio: "inherit",
			env: { ...process.env, TZ: "UTC", TEST_DATABASE: database, TEST_ADAPTER: adapter },
		});
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
}
