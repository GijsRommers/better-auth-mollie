import type { AuthContext } from "better-auth";
import type { MollieOperation, MollieOperationKind } from "./types";
import { isDefinitiveMollieError } from "./utils";

/**
 * A pending operation younger than this may still be in flight, so it is
 * neither repeated nor written off.
 */
export const IN_FLIGHT_WINDOW_MS = 2 * 60 * 1000;

export class OperationInProgressError extends Error {
	readonly idempotencyKey: string;
	constructor(idempotencyKey: string) {
		super(`Mollie operation ${idempotencyKey} is still in progress`);
		this.name = "OperationInProgressError";
		this.idempotencyKey = idempotencyKey;
	}
}

export type RunOperationOptions<T> = {
	kind: MollieOperationKind;
	referenceId: string;
	/**
	 * Deterministic description of the intent, e.g.
	 * `activate:<subscriptionId>:<paymentId>`. Attempts are numbered within it.
	 */
	scope: string;
	/**
	 * Return an earlier successful attempt instead of calling Mollie again.
	 * `true` for one-shot intents (create the customer for X, activate Y).
	 */
	reuseSucceeded: boolean;
	/** Performs the Mollie call. Must send `idempotencyKey` along. */
	execute: (idempotencyKey: string) => Promise<T>;
	getId: (result: T) => string;
	/**
	 * Find the resource an earlier attempt may have created, by the
	 * `operationKey` stored in its Mollie metadata. Returns its id or `null`.
	 */
	recover: (idempotencyKey: string) => Promise<string | null>;
	now?: (() => Date) | undefined;
};

export type OperationResult<T> = {
	mollieId: string;
	idempotencyKey: string;
	/** The Mollie response, only present when this call performed the operation. */
	result?: T | undefined;
	/** `true` when an earlier attempt (or recovery) supplied the result. */
	replayed: boolean;
};

async function markOperation(
	context: AuthContext,
	idempotencyKey: string,
	status: "succeeded" | "failed",
	mollieId: string | null,
) {
	await context.adapter.update({
		model: "mollieOperation",
		where: [
			{ field: "idempotencyKey", value: idempotencyKey },
			{ field: "status", value: "pending" },
		],
		update: { status, mollieId },
	});
}

/**
 * Runs a mutating Mollie call through the `mollieOperation` journal.
 *
 * 1. The journal row is written (status `pending`) before Mollie is called.
 * 2. Mollie receives the same value as `Idempotency-Key`, and it is stored in
 *    the created resource's metadata as `operationKey`.
 * 3. The row is marked `succeeded` (with the Mollie id) or, for errors that
 *    prove nothing happened, `failed`.
 *
 * If a process dies between 1 and 3, the next call for the same scope finds
 * the `pending` row and looks the resource up by `operationKey` instead of
 * creating a duplicate. This also works after Mollie's one-hour idempotency
 * window has passed.
 */
export async function runOperation<T>(
	context: AuthContext,
	options: RunOperationOptions<T>,
): Promise<OperationResult<T>> {
	const now = options.now ?? (() => new Date());
	const prefix = `${options.scope}#`;
	const attempts = (
		await context.adapter.findMany<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "referenceId", value: options.referenceId },
				{ field: "kind", value: options.kind },
			],
		})
	).filter((op) => op.idempotencyKey.startsWith(prefix));

	if (options.reuseSucceeded) {
		const done = attempts.find((op) => op.status === "succeeded" && op.mollieId);
		if (done?.mollieId) {
			return { mollieId: done.mollieId, idempotencyKey: done.idempotencyKey, replayed: true };
		}
	}

	for (const op of attempts) {
		if (op.status !== "pending") continue;
		const recovered = await options.recover(op.idempotencyKey);
		if (recovered) {
			await markOperation(context, op.idempotencyKey, "succeeded", recovered);
			context.logger.info(
				`[mollie] Recovered ${options.kind} ${recovered} from pending operation ${op.idempotencyKey}`,
			);
			return { mollieId: recovered, idempotencyKey: op.idempotencyKey, replayed: true };
		}
		const age = now().getTime() - new Date(op.createdAt).getTime();
		if (age < IN_FLIGHT_WINDOW_MS) throw new OperationInProgressError(op.idempotencyKey);
		// Older than the in-flight window and nothing exists at Mollie: the
		// call never took effect. Write it off and start a new attempt.
		await markOperation(context, op.idempotencyKey, "failed", null);
	}

	const idempotencyKey = `${prefix}${attempts.length + 1}`;
	try {
		await context.adapter.create({
			model: "mollieOperation",
			data: {
				idempotencyKey,
				kind: options.kind,
				referenceId: options.referenceId,
				status: "pending",
				mollieId: null,
				createdAt: now(),
			},
		});
	} catch (error) {
		const existing = await context.adapter.findOne<MollieOperation>({
			model: "mollieOperation",
			where: [{ field: "idempotencyKey", value: idempotencyKey }],
		});
		// Unique constraint: a concurrent request claimed this attempt.
		if (existing) throw new OperationInProgressError(idempotencyKey);
		throw error;
	}

	let result: T;
	try {
		result = await options.execute(idempotencyKey);
	} catch (error) {
		if (isDefinitiveMollieError(error)) {
			await markOperation(context, idempotencyKey, "failed", null);
		}
		// Otherwise the outcome is unknown: leave the row pending so the next
		// attempt recovers it.
		throw error;
	}
	const mollieId = options.getId(result);
	await markOperation(context, idempotencyKey, "succeeded", mollieId);
	return { mollieId, idempotencyKey, result, replayed: false };
}

/** Finds the first resource in a Mollie page whose metadata carries `operationKey`. */
export function findByOperationKey<T extends { id: string; metadata?: unknown }>(
	items: Iterable<T>,
	operationKey: string,
): string | null {
	for (const item of items) {
		const metadata = item.metadata as Record<string, unknown> | null | undefined;
		if (metadata && metadata.operationKey === operationKey) return item.id;
	}
	return null;
}
