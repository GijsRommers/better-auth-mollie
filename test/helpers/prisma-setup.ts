import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getSchema } from "better-auth/db";
import { organization } from "better-auth/plugins/organization";
import { mollie } from "../../src";
import { createFakeMollie } from "./fake-mollie";

const PROVIDERS = { sqlite: "sqlite", postgres: "postgresql", mysql: "mysql" } as const;
const PRISMA_TYPES = { date: "DateTime", boolean: "Boolean", number: "Int" } as const;

/**
 * Vitest global setup: generates the Prisma client and DDL for the selected
 * engine from the plugin's actual fields, once, before the workers start.
 */
export default async function setup() {
	if (process.env.TEST_ADAPTER !== "prisma") return;
	const database = process.env.TEST_DATABASE ?? "sqlite";
	const provider = PROVIDERS[database as keyof typeof PROVIDERS];
	if (!provider) throw new Error(`No Prisma provider for TEST_DATABASE: ${database}`);

	const schema = getSchema({
		plugins: [
			organization(),
			mollie({
				mollieClient: createFakeMollie().client,
				subscription: {
					enabled: true,
					authorizeReference: async () => true,
					plans: [{ name: "test", amount: "1.00", interval: "1 month" }],
				},
			}),
		],
	});
	const models = Object.entries(schema).map(([name, table]) => {
		const fields = Object.entries(table.fields).map(([key, field]) => {
			const type = PRISMA_TYPES[field.type as keyof typeof PRISMA_TYPES] ?? "String";
			return `  ${key} ${type}${field.required ? "" : "?"}${field.unique ? " @unique" : ""}`;
		});
		return `model ${name} {\n  id String @id\n${fields.join("\n")}\n}`;
	});

	const directory = resolve("test/.generated", database);
	await mkdir(directory, { recursive: true });
	const schemaPath = resolve(directory, "schema.prisma");
	await writeFile(
		schemaPath,
		`generator client {\n  provider = "prisma-client-js"\n  output = "./client"\n}\ndatasource db {\n  provider = "${provider}"\n  url = env("PRISMA_TEST_URL")\n}\n${models.join("\n\n")}\n`,
	);

	// Neither command connects; the URL only has to parse for the provider.
	const env = {
		...process.env,
		PRISMA_TEST_URL:
			provider === "sqlite" ? "file:unused.db" : `${provider}://test:test@localhost/unused`,
	};
	const prisma = (...args: string[]) => execFileSync("pnpm", ["exec", "prisma", ...args], { env });
	const ddl = prisma(
		"migrate",
		"diff",
		"--from-empty",
		"--to-schema-datamodel",
		schemaPath,
		"--script",
	);
	await writeFile(resolve(directory, "migration.sql"), ddl);
	prisma("generate", "--schema", schemaPath);
}
