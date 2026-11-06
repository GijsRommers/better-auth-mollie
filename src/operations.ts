import type { AuthContext } from "better-auth";
import type { MollieOperation, MollieOperationKind } from "./types";
import { isMollieConflict, isRejectedMollieRequest } from "./utils";

/**
 * Mollie keeps idempotency keys for one hour. Within this window a pending
 * attempt is re-sent with the same key, which can never create a duplicate:
 * Mollie replays a completed request, answers 409 to one still running, or
 * performs one that never arrived.
 */
export const REPLAY_WINDOW_MS = 50 * 60 * 1000;

const PAGE_SIZE = 100;

export class OperationInProgressError extends Error {
	readonly idempotencyKey: string;
	constructor(idempotencyKey: string) {
		super(`Mollie operation ${idempotencyKey} is still in progress`);
		this.name = "OperationInProgressError";
		this.idempotencyKey = idempotencyKey;
	}
}

/**
 * Thrown when an attempt finished after it had been written off and a newer
 * attempt took over its intent. The late result is compensated, not used.
 */
export class OperationSupersededError extends Error {
	readonly idempotencyKey: string;
	readonly mollieId: string;
	constructor(idempotencyKey: string, mollieId: string) {
		super(`Mollie operation ${idempotencyKey} finished after it was superseded (${mollieId})`);
		this.name = "OperationSupersededError";
		this.idempotencyKey = idempotencyKey;
		this.mollieId = mollieId;
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
	/**
	 * Performs the Mollie call with `idempotencyKey`. For a given key it must
	 * send the same parameters, because a pending attempt is re-sent.
	 */
	execute: (idempotencyKey: string) => Promise<T>;
	getId: (result: T) => string;
	/**
	 * Find the resource an earlier attempt may have created, by the
	 * `operationKey` stored in its Mollie metadata. Returns its id or `null`.
	 */
	recover: (idempotencyKey: string) => Promise<string | null>;
	/**
	 * Undo a resource created by an attempt that finished after it was
	 * superseded, e.g. cancel a duplicate subscription.
	 */
	compensate?: ((mollieId: string) => Promise<void>) | undefined;
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

/**
 * Guarded `pending → status` transition. Returns `false` when the row was no
 * longer pending (someone else resolved it first).
 */
async function resolveOperation(
	context: AuthContext,
	idempotencyKey: string,
	status: "succeeded" | "failed",
	mollieId: string | null,
): Promise<boolean> {
	const row = await context.adapter.incrementOne({
		model: "mollieOperation",
		where: [
			{ field: "idempotencyKey", value: idempotencyKey },
			{ field: "status", value: "pending" },
		],
		increment: {},
		set: { status, mollieId },
	});
	return row !== null;
}

async function loadAttempts(context: AuthContext, options: RunOperationOptions<unknown>) {
	const prefix = `${options.scope}#`;
	const attempts: MollieOperation[] = [];
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const page = await context.adapter.findMany<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "referenceId", value: options.referenceId },
				{ field: "kind", value: options.kind },
				// SQL adapters implement this as an unescaped, possibly
				// case-insensitive LIKE, so it may over-match; filtered below.
				{ field: "idempotencyKey", operator: "starts_with", value: prefix },
			],
			sortBy: { field: "idempotencyKey", direction: "asc" },
			limit: PAGE_SIZE,
			offset,
		});
		attempts.push(...page);
		if (page.length < PAGE_SIZE) break;
	}
	return attempts.filter((op) => op.idempotencyKey.startsWith(prefix));
}

function attemptNumber(idempotencyKey: string, scope: string): number {
	const value = Number(idempotencyKey.slice(scope.length + 1));
	return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Runs a mutating Mollie call through the `mollieOperation` journal.
 *
 * 1. The journal row is written (status `pending`) before Mollie is called.
 * 2. Mollie receives the same value as `Idempotency-Key`, and it is stored in
 *    the created resource's metadata as `operationKey`.
 * 3. The row is marked `succeeded` (with the Mollie id), or `failed` when
 *    Mollie's answer proves nothing happened.
 *
 * When a process dies between 1 and 3, the next call for the same scope finds
 * the `pending` row and first looks the resource up by `operationKey`. If it
 * is not found, the attempt is re-sent with the same key while Mollie still
 * remembers it; after that window, the lookup is authoritative and a new
 * attempt starts.
 */
export async function runOperation<T>(
	context: AuthContext,
	options: RunOperationOptions<T>,
): Promise<OperationResult<T>> {
	const now = options.now ?? (() => new Date());
	const attempts = await loadAttempts(context, options as RunOperationOptions<unknown>);

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
			await resolveOperation(context, op.idempotencyKey, "succeeded", recovered);
			context.logger.info(
				`[mollie] Recovered ${options.kind} ${recovered} from pending operation ${op.idempotencyKey}`,
			);
			return { mollieId: recovered, idempotencyKey: op.idempotencyKey, replayed: true };
		}
		const age = now().getTime() - new Date(op.createdAt).getTime();
		if (age < REPLAY_WINDOW_MS) {
			return executeAttempt(context, options, op.idempotencyKey);
		}
		// Mollie no longer remembers this key and nothing carries its
		// operationKey, so the attempt never took effect.
		await resolveOperation(context, op.idempotencyKey, "failed", null);
	}

	const next = Math.max(
		0,
		...attempts.map((op) => attemptNumber(op.idempotencyKey, options.scope)),
	);
	const idempotencyKey = `${options.scope}#${next + 1}`;
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
	return executeAttempt(context, options, idempotencyKey);
}

async function executeAttempt<T>(
	context: AuthContext,
	options: RunOperationOptions<T>,
	idempotencyKey: string,
): Promise<OperationResult<T>> {
	let result: T;
	try {
		result = await options.execute(idempotencyKey);
	} catch (error) {
		if (isMollieConflict(error)) throw new OperationInProgressError(idempotencyKey);
		if (isRejectedMollieRequest(error)) {
			await resolveOperation(context, idempotencyKey, "failed", null);
		}
		// Anything else (network errors, 5xx, 429, a 400 that may be an
		// idempotency-key mismatch) leaves the outcome unknown: stay pending.
		throw error;
	}
	const mollieId = options.getId(result);
	if (await resolveOperation(context, idempotencyKey, "succeeded", mollieId)) {
		return { mollieId, idempotencyKey, result, replayed: false };
	}

	// The row was resolved while we were waiting for Mollie.
	const current = await context.adapter.findOne<MollieOperation>({
		model: "mollieOperation",
		where: [{ field: "idempotencyKey", value: idempotencyKey }],
	});
	if (current?.status === "succeeded" && current.mollieId === mollieId) {
		// A concurrent re-send of this key got Mollie's replay of our request.
		return { mollieId, idempotencyKey, result, replayed: false };
	}
	context.logger.error(
		`[mollie] ${options.kind} ${mollieId} finished after operation ${idempotencyKey} was written off; compensating`,
	);
	await options.compensate?.(mollieId);
	throw new OperationSupersededError(idempotencyKey, mollieId);
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
