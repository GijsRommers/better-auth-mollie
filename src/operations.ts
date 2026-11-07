import type { AuthContext, Where } from "better-auth";
import type { MollieOperation, MollieOperationKind } from "./types";
import { isMollieBadRequest, isMollieConflict, isRejectedMollieRequest } from "./utils";

/**
 * Mollie keeps idempotency keys for one hour. Within this window a pending
 * attempt is re-sent with the same key, which can never create a duplicate:
 * Mollie replays a completed request, answers 409 to one still running, or
 * performs one that never arrived.
 */
export const REPLAY_WINDOW_MS = 50 * 60 * 1000;

const PAGE_SIZE = 100;

/** Mollie rejects longer idempotency keys (verified against the API). */
export const MOLLIE_MAX_KEY_LENGTH = 100;

/**
 * The key sent to Mollie (as `Idempotency-Key` and `metadata.operationKey`)
 * for a journal key. Short keys are used as-is; longer ones keep a readable
 * prefix and end in a SHA-256 hash of the full key, staying within Mollie's
 * 100-character limit while remaining unique and deterministic.
 */
export async function mollieKey(idempotencyKey: string): Promise<string> {
	if (idempotencyKey.length <= MOLLIE_MAX_KEY_LENGTH) return idempotencyKey;
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(idempotencyKey),
	);
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	return `${idempotencyKey.slice(0, MOLLIE_MAX_KEY_LENGTH - hash.length - 1)}~${hash}`;
}

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
	 * `true`: return an earlier successful attempt instead of calling Mollie
	 * again (one-shot intents: create the customer for X, activate Y).
	 *
	 * `false`: start a new attempt even if an earlier one succeeded. Attempts
	 * that are still unresolved (in flight, recoverable, or finishing while
	 * being written off) are always joined, so concurrent callers of the same
	 * scope share one Mollie resource. Put everything that must not be shared
	 * (e.g. plan and amount of a checkout) into `scope`.
	 */
	reuseSucceeded: boolean;
	/**
	 * Performs the Mollie call with `idempotencyKey` (send it as the
	 * Idempotency-Key and as `metadata.operationKey`). It is derived from the
	 * journal key and at most 100 characters long. A pending attempt is re-sent
	 * with its key; if the parameters changed meanwhile, Mollie answers 400
	 * and the journal falls back to `recover`.
	 */
	execute: (idempotencyKey: string) => Promise<T>;
	getId: (result: T) => string;
	/**
	 * Find the resource an attempt may have created, by the `operationKey`
	 * (the same derived key `execute` received) stored in its Mollie metadata. Must search completely (all resources
	 * created since `attempt.createdAt`, with some slack for clock skew) or
	 * throw: `null` is taken as proof that nothing was created.
	 */
	recover: (idempotencyKey: string, attempt: { createdAt: Date }) => Promise<string | null>;
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
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const outcome = await runRound(context, options);
		if (outcome !== RELOAD) return outcome;
	}
	// Persistent contention on this scope; the caller should retry later.
	throw new OperationInProgressError(`${options.scope}#*`);
}

/** Returned by a round that lost a race and must re-read the journal. */
const RELOAD = Symbol("reload");
const MAX_ROUNDS = 3;

async function readOperation(context: AuthContext, idempotencyKey: string) {
	return context.adapter.findOne<MollieOperation>({
		model: "mollieOperation",
		where: [{ field: "idempotencyKey", value: idempotencyKey }],
	});
}

/**
 * Called after losing a guarded transition on `idempotencyKey`. Only the
 * journal row decides what happened: if the attempt succeeded in the
 * meantime its resource is the result; if it was written off, the round
 * reloads so it sees (and joins) the replacement attempt.
 */
async function settleLostTransition<T>(
	context: AuthContext,
	idempotencyKey: string,
): Promise<OperationResult<T> | typeof RELOAD> {
	const current = await readOperation(context, idempotencyKey);
	if (current?.status === "succeeded" && current.mollieId) {
		return { mollieId: current.mollieId, idempotencyKey, replayed: true };
	}
	return RELOAD;
}

async function runRound<T>(
	context: AuthContext,
	options: RunOperationOptions<T>,
): Promise<OperationResult<T> | typeof RELOAD> {
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
		const createdAt = new Date(op.createdAt);
		const recovered = await options.recover(await mollieKey(op.idempotencyKey), { createdAt });
		if (recovered) {
			if (await resolveOperation(context, op.idempotencyKey, "succeeded", recovered)) {
				context.logger.info(
					`[mollie] Recovered ${options.kind} ${recovered} from pending operation ${op.idempotencyKey}`,
				);
				return { mollieId: recovered, idempotencyKey: op.idempotencyKey, replayed: true };
			}
			// The row was resolved concurrently. If it was written off, the
			// resource we found is being compensated and must not be used.
			return settleLostTransition(context, op.idempotencyKey);
		}
		const age = now().getTime() - createdAt.getTime();
		if (age < REPLAY_WINDOW_MS) {
			return executeAttempt(context, options, op.idempotencyKey, { resend: true, createdAt });
		}
		// Mollie no longer remembers this key and nothing carries its
		// operationKey, so the attempt never took effect...
		if (!(await resolveOperation(context, op.idempotencyKey, "failed", null))) {
			// ...unless it just finished: then its result is ours.
			return settleLostTransition(context, op.idempotencyKey);
		}
	}

	const next = Math.max(
		0,
		...attempts.map((op) => attemptNumber(op.idempotencyKey, options.scope)),
	);
	const idempotencyKey = `${options.scope}#${next + 1}`;
	const createdAt = now();
	try {
		await context.adapter.create({
			model: "mollieOperation",
			data: {
				idempotencyKey,
				kind: options.kind,
				referenceId: options.referenceId,
				status: "pending",
				mollieId: null,
				createdAt,
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
	return executeAttempt(context, options, idempotencyKey, { resend: false, createdAt });
}

async function executeAttempt<T>(
	context: AuthContext,
	options: RunOperationOptions<T>,
	idempotencyKey: string,
	attempt: { resend: boolean; createdAt: Date },
): Promise<OperationResult<T> | typeof RELOAD> {
	const remoteKey = await mollieKey(idempotencyKey);
	let result: T;
	try {
		result = await options.execute(remoteKey);
	} catch (error) {
		if (isMollieConflict(error)) throw new OperationInProgressError(idempotencyKey);
		if (isMollieBadRequest(error)) {
			if (!attempt.resend) {
				// A fresh key cannot clash, so Mollie rejected the request itself.
				await resolveOperation(context, idempotencyKey, "failed", null);
				throw error;
			}
			// Mollie already holds a response for this key, but for other
			// parameters. If that response created the resource, the lookup finds
			// it; otherwise the earlier request failed and a new attempt is safe.
			const recovered = await options.recover(remoteKey, { createdAt: attempt.createdAt });
			if (recovered) {
				if (await resolveOperation(context, idempotencyKey, "succeeded", recovered)) {
					return { mollieId: recovered, idempotencyKey, replayed: true };
				}
				return settleLostTransition(context, idempotencyKey);
			}
			if (await resolveOperation(context, idempotencyKey, "failed", null)) return RELOAD;
			return settleLostTransition(context, idempotencyKey);
		}
		if (isRejectedMollieRequest(error)) {
			await resolveOperation(context, idempotencyKey, "failed", null);
		}
		// Anything else (network errors, timeouts, 5xx, 429) leaves the outcome
		// unknown: stay pending so the next call recovers or re-sends it.
		throw error;
	}
	const mollieId = options.getId(result);
	if (await resolveOperation(context, idempotencyKey, "succeeded", mollieId)) {
		return { mollieId, idempotencyKey, result, replayed: false };
	}

	// The row was resolved while we were waiting for Mollie.
	const current = await readOperation(context, idempotencyKey);
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

/** How long a lifecycle lock is held without renewal before others may take it over. */
export const LOCK_LEASE_MS = 2 * 60 * 1000;

/** The lock was taken over by someone else after its lease expired. */
export class LockLostError extends OperationInProgressError {
	constructor(key: string) {
		super(key);
		this.name = "LockLostError";
	}
}

/** Renews the lease and proves it is still ours; throws `LockLostError` otherwise. */
export type Fence = () => Promise<void>;

function newToken(): string {
	return globalThis.crypto.randomUUID();
}

/**
 * Runs `fn` while holding a lease lock stored in the journal table (adapter
 * only, no row locks). Each holder gets a random token (stored in
 * `mollieId`); renewal and release only work for that token, so identity
 * never depends on timestamp equality.
 *
 * `fn` receives `fence`: call it right before any charge or write. It renews
 * the lease and throws if another caller took it over (possible only after a
 * pause longer than `LOCK_LEASE_MS`), so a stalled holder cannot act on a
 * stale view.
 */
export async function withLock<T>(
	context: AuthContext,
	input: { key: string; referenceId: string; now?: (() => Date) | undefined },
	fn: (fence: Fence) => Promise<T>,
): Promise<T> {
	const now = input.now ?? (() => new Date());
	const token = newToken();
	const { adapter } = context;
	const claim = { status: "pending", mollieId: token, createdAt: now() };
	let claimed = false;
	try {
		await adapter.create({
			model: "mollieOperation",
			data: {
				idempotencyKey: input.key,
				kind: "lifecycle_lock",
				referenceId: input.referenceId,
				...claim,
			},
		});
		claimed = true;
	} catch (error) {
		const existing = await readOperation(context, input.key);
		if (!existing) throw error;
		const where: Where[] = [
			{ field: "idempotencyKey", value: input.key },
			{ field: "mollieId", value: existing.mollieId ?? "" },
		];
		if (existing.status === "pending") {
			// Only an expired lease can be taken over; a renewal moves createdAt
			// past the cutoff and makes this fail.
			where.push(
				{ field: "status", value: "pending" },
				{ field: "createdAt", operator: "lt", value: new Date(now().getTime() - LOCK_LEASE_MS) },
			);
		} else {
			where.push({ field: "status", value: existing.status });
		}
		claimed =
			(await adapter.incrementOne({
				model: "mollieOperation",
				where,
				increment: {},
				set: claim,
			})) !== null;
	}
	if (!claimed) throw new OperationInProgressError(input.key);

	const mine: Where[] = [
		{ field: "idempotencyKey", value: input.key },
		{ field: "mollieId", value: token },
		{ field: "status", value: "pending" },
	];
	const fence: Fence = async () => {
		const renewed = await adapter.incrementOne({
			model: "mollieOperation",
			where: mine,
			increment: {},
			set: { createdAt: now() },
		});
		if (!renewed) throw new LockLostError(input.key);
	};
	const release = (status: "succeeded" | "failed") =>
		adapter
			.incrementOne({ model: "mollieOperation", where: mine, increment: {}, set: { status } })
			.catch(() => null);
	try {
		const result = await fn(fence);
		await release("succeeded");
		return result;
	} catch (error) {
		await release("failed");
		throw error;
	}
}
