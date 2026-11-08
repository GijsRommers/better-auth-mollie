import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getSchema } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";
import { getTestInstance } from "better-auth/test";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import * as mysqlCore from "drizzle-orm/mysql-core";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import * as pgCore from "drizzle-orm/pg-core";
import * as sqliteCore from "drizzle-orm/sqlite-core";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";
import { afterEach } from "vitest";

const DATABASES = ["sqlite", "postgres", "mysql", "memory"] as const;
const ADAPTERS = ["kysely", "drizzle", "prisma"] as const;

/** The engine and the Better Auth adapter this run tests (`TEST_DATABASE`, `TEST_ADAPTER`). */
export const database = select("TEST_DATABASE", DATABASES);
export const adapter = select("TEST_ADAPTER", ADAPTERS);
if (database === "mysql" && adapter === "prisma") {
	throw new Error(
		"Prisma 6/MySQL does not honor guarded-update results. Billing is unsupported; run pnpm test:prisma-mysql-contract for the diagnostic.",
	);
}

function select<const T extends readonly string[]>(name: string, allowed: T): T[number] {
	const value = process.env[name] ?? allowed[0]!;
	if (!(allowed as readonly string[]).includes(value)) throw new Error(`Unknown ${name}: ${value}`);
	return value as T[number];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A disposable database: a temporary file, or one created on the test server. */
type Connection = {
	url: string;
	/** The driver, for Better Auth's own Kysely adapter and migrations. */
	db: BetterAuthOptions["database"];
	/** Runs generated DDL. */
	exec(ddl: string): Promise<void>;
	drizzle(schema: Record<string, unknown>): Parameters<typeof drizzleAdapter>[0];
};

/** Any column type the plugin's fields do not use falls back to `string`. */
type ColumnBuilders = Record<"date" | "boolean" | "number" | "string", (name: string) => any>;

type Engine = {
	drizzleProvider: "pg" | "mysql" | "sqlite";
	prismaProvider: "postgresql" | "mysql" | "sqlite";
	table: (name: string, columns: Record<string, any>) => unknown;
	column: ColumnBuilders;
	connect(): Promise<Connection>;
};

type SqlPool = { query(sql: string): Promise<unknown>; end(): Promise<void> };

/**
 * A database of its own on the test server. Kysely introspects every schema,
 * so tests sharing one PostgreSQL database raced with each other's teardown.
 */
async function createServerDatabase<P extends SqlPool>(
	server: string,
	open: (url: string) => P,
	quote: (name: string) => string,
) {
	const name = `mollie_test_${randomUUID().replaceAll("-", "")}`;
	const admin = open(server);
	try {
		await admin.query(`CREATE DATABASE ${quote(name)}`);
	} catch (error) {
		await admin.end();
		throw error;
	}
	const url = new URL(server);
	url.pathname = `/${name}`;
	const db = open(url.href);
	cleanups.push(async () => {
		await db.end();
		try {
			await admin.query(`DROP DATABASE ${quote(name)}`);
		} finally {
			await admin.end();
		}
	});
	return { url: url.href, db };
}

const engines: Record<Exclude<typeof database, "memory">, Engine> = {
	sqlite: {
		drizzleProvider: "sqlite",
		prismaProvider: "sqlite",
		table: sqliteCore.sqliteTable,
		column: {
			date: (name) => sqliteCore.integer(name, { mode: "timestamp_ms" }),
			boolean: (name) => sqliteCore.integer(name, { mode: "boolean" }),
			number: (name) => sqliteCore.integer(name),
			string: (name) => sqliteCore.text(name),
		},
		async connect() {
			const directory = await mkdtemp(join(tmpdir(), "mollie-test-"));
			const db = new Database(join(directory, "test.db"));
			cleanups.push(async () => {
				db.close();
				await rm(directory, { recursive: true });
			});
			return {
				url: `file:${db.name}`,
				db,
				async exec(ddl) {
					db.exec(ddl);
				},
				drizzle: (schema) => drizzleSqlite(db, { schema }),
			};
		},
	},
	postgres: {
		drizzleProvider: "pg",
		prismaProvider: "postgresql",
		table: pgCore.pgTable,
		column: {
			date: (name) => pgCore.timestamp(name, { withTimezone: true }),
			boolean: (name) => pgCore.boolean(name),
			number: (name) => pgCore.integer(name),
			string: (name) => pgCore.text(name),
		},
		async connect() {
			const { url, db } = await createServerDatabase(
				process.env.TEST_POSTGRES_URL ?? "postgres://test:test@127.0.0.1:55432/billing_test",
				(url) => new Pool({ connectionString: url, max: 4 }),
				(name) => `"${name}"`,
			);
			return {
				url,
				db,
				async exec(ddl) {
					await db.query(ddl);
				},
				drizzle: (schema) => drizzlePostgres(db, { schema }),
			};
		},
	},
	mysql: {
		drizzleProvider: "mysql",
		prismaProvider: "mysql",
		table: mysqlCore.mysqlTable,
		column: {
			date: (name) => mysqlCore.timestamp(name, { fsp: 3 }),
			boolean: (name) => mysqlCore.boolean(name),
			number: (name) => mysqlCore.int(name),
			string: (name) => mysqlCore.varchar(name, { length: 255 }),
		},
		async connect() {
			const { url, db } = await createServerDatabase(
				process.env.TEST_MYSQL_URL ?? "mysql://root:test@127.0.0.1:53306",
				(url) => createPool(url),
				(name) => `\`${name}\``,
			);
			return {
				url,
				db,
				async exec(ddl) {
					// mysql2 runs one statement per query.
					for (const statement of ddl.split(";")) {
						if (statement.trim()) await db.query(statement);
					}
				},
				drizzle: (schema) => drizzleMysql(db, { schema, mode: "default" }),
			};
		},
	},
};

/**
 * Better Auth's test instance on the selected engine and adapter. Each instance
 * owns a fresh database, so no caller's existing tables are ever migrated.
 */
export const databaseTestInstance: typeof getTestInstance = async (options, config) => {
	// The memory adapter and callers that bring their own database (setup.ts's
	// `memory`) need nothing; SQLite on Kysely is Better Auth's default.
	if (
		database === "memory" ||
		options?.database ||
		(database === "sqlite" && adapter === "kysely")
	) {
		return getTestInstance(options, config);
	}
	const engine = engines[database];
	const connection = await engine.connect();
	let selected: BetterAuthOptions["database"] = connection.db;
	if (adapter === "prisma") {
		// Client and DDL generated by prisma-setup.ts before the workers started.
		const generated = resolve("test/.generated", database);
		await connection.exec(await readFile(join(generated, "migration.sql"), "utf8"));
		const { PrismaClient } = await import(pathToFileURL(join(generated, "client/index.js")).href);
		const client = new PrismaClient({ datasources: { db: { url: connection.url } } });
		cleanups.push(() => client.$disconnect());
		selected = prismaAdapter(client, { provider: engine.prismaProvider });
	} else {
		await (await getMigrations({ ...options, database: connection.db })).runMigrations();
		if (adapter === "drizzle") {
			const schema = drizzleSchema(engine, options ?? {});
			selected = drizzleAdapter(connection.drizzle(schema), {
				schema,
				provider: engine.drizzleProvider,
			});
		}
	}
	return getTestInstance({ ...options, database: selected }, config) as any;
};

/** Drizzle tables matching the columns Better Auth migrated, instead of a hand-kept second schema. */
function drizzleSchema(engine: Engine, options: BetterAuthOptions) {
	return Object.fromEntries(
		Object.entries(getSchema(options)).map(([name, table]) => {
			const columns: Record<string, any> = {};
			for (const [fieldName, field] of Object.entries(table.fields)) {
				const build = engine.column[field.type as keyof ColumnBuilders] ?? engine.column.string;
				let column = build(fieldName);
				if (field.unique) column = column.unique();
				if (field.required) column = column.notNull();
				columns[fieldName] = column;
			}
			columns.id = engine.column.string("id").primaryKey();
			return [name, engine.table(name, columns)];
		}),
	);
}
