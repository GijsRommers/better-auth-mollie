import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createPool } from "mysql2/promise";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mollieOperationSchema } from "../../src/schema";
import type { MollieOperation } from "../../src/types";

let lost: MollieOperation | null;
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

// Setup and winner checks deliberately live outside it.fails: connection errors,
// migration errors, or a wrong durable winner must fail CI normally.
beforeAll(async () => {
	const name = `mollie_test_${randomUUID().replaceAll("-", "")}`;
	const server = process.env.TEST_MYSQL_URL ?? "mysql://root:test@127.0.0.1:53306";
	const admin = createPool(server);
	const url = new URL(server);
	url.pathname = `/${name}`;
	const sql = createPool(url.href);
	const generated = resolve("test/.generated/mysql");
	const { PrismaClient } = await import(pathToFileURL(resolve(generated, "client/index.js")).href);
	const client = new PrismaClient({ datasources: { db: { url: url.href } } });
	cleanups.push(async () => {
		await client.$disconnect();
		await sql.end();
		try {
			await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
		} finally {
			await admin.end();
		}
	});
	await admin.query(`CREATE DATABASE \`${name}\``);
	const ddl = await readFile(resolve(generated, "migration.sql"), "utf8");
	for (const statement of ddl.split(";")) if (statement.trim()) await sql.query(statement);
	await client.mollieOperation.create({
		data: {
			id: "claim",
			idempotencyKey: "claim",
			kind: "lifecycle_lock",
			referenceId: "test",
			status: "pending",
			createdAt: new Date(),
		},
	});
	let signalRead!: () => void;
	let continueLoser!: () => void;
	const snapshotRead = new Promise<void>((resolve) => {
		signalRead = resolve;
	});
	const applyLoser = new Promise<void>((resolve) => {
		continueLoser = resolve;
	});
	const adapter = (db: any) =>
		prismaAdapter(db, { provider: "mysql" })({
			plugins: [{ id: "contract", schema: mollieOperationSchema }],
		});
	const claim = (db: any, token: string) =>
		adapter(db).incrementOne<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "id", value: "claim" },
				{ field: "status", value: "pending" },
			],
			increment: {},
			set: { status: "succeeded", mollieId: token },
		});
	const loser = client.$transaction(
		async (tx: any) => {
			// Prisma's MySQL update reads before updating. Establish that snapshot
			// explicitly so the competing commit always happens between the reads.
			await tx.mollieOperation.findUniqueOrThrow({ where: { id: "claim" } });
			signalRead();
			await applyLoser;
			return claim(tx, "loser");
		},
		{ isolationLevel: "RepeatableRead" },
	);
	await snapshotRead;
	try {
		const winner = await claim(client, "winner");
		expect(winner?.mollieId).toBe("winner");
	} finally {
		continueLoser();
	}
	lost = await loser;
	const stored = await client.mollieOperation.findUniqueOrThrow({ where: { id: "claim" } });
	expect(stored.mollieId).toBe("winner");
});

// An unexpected pass means the dependency changed: revalidate billing and
// revisit support instead of silently treating the known bug as resolved.
it.fails("Prisma 6/MySQL returns null when a guarded update loses to a committed writer", () => {
	expect(lost).toBeNull();
});
