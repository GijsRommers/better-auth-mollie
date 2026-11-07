import type { AuthContext } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins/organization";
import { getTestInstance } from "better-auth/test";
import { vi } from "vitest";
import { mollie } from "../../src";
import { mollieClient } from "../../src/client";
import type {
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	Subscription,
	SubscriptionOptions,
} from "../../src/types";
import { createFakeMollie, type FakeMollie } from "./fake-mollie";

export const BASE_URL = "http://app.example.com";
export const AUTH_URL = `${BASE_URL}/api/auth`;

export const PLANS: MolliePlan[] = [
	{ name: "starter", amount: "9.95", interval: "1 month", limits: { projects: 3 } },
	{
		name: "pro",
		amount: "29.00",
		interval: "1 month",
		freeTrial: { days: 14 },
		limits: { projects: 50 },
	},
	{ name: "business", amount: "49.00", interval: "1 month", limits: { projects: 500 } },
	{ name: "yearly", amount: "290.00", interval: "12 months" },
];

type SetupOptions = {
	/** Use organization billing (adds the organization plugin). */
	organization?: boolean;
	subscription?: Partial<SubscriptionOptions>;
	options?: Partial<MollieOptions>;
	fake?: FakeMollie;
	/** Extra Better Auth options. */
	auth?: Record<string, unknown>;
	/** Run on Better Auth's memory adapter instead of SQLite. */
	memory?: boolean;
};

/** Tables for the memory adapter, which does not create them itself. */
function memoryDatabase() {
	const models = ["user", "session", "account", "verification", "organization", "member"];
	const plugin = ["invitation", "subscription", "molliePayment", "mollieOperation"];
	return memoryAdapter(Object.fromEntries([...models, ...plugin].map((model) => [model, []])));
}

export async function setup(input: SetupOptions = {}) {
	const fake = input.fake ?? createFakeMollie();
	const hooks = {
		onSubscriptionActivated: vi.fn(async (..._args: any[]) => {}),
		onPaymentPaid: vi.fn(async (..._args: any[]) => {}),
		onPaymentFailed: vi.fn(async (..._args: any[]) => {}),
		onSubscriptionCanceled: vi.fn(async (..._args: any[]) => {}),
	};
	const authorizeReference = vi.fn(async (..._args: any[]) => true);
	const pluginOptions = {
		mollieClient: fake.client,
		// Short, so tests of a busy subscription (409, OPERATION_IN_PROGRESS) stay fast.
		lockWaitMs: 300,
		subscription: {
			enabled: true as const,
			plans: PLANS,
			customerType: input.organization ? ("organization" as const) : ("user" as const),
			authorizeReference,
			...hooks,
			...input.subscription,
		},
		...input.options,
	} satisfies MollieOptions;

	const instance = await getTestInstance(
		{
			baseURL: BASE_URL,
			// `TEST_DATABASE=memory` runs every test on the memory adapter.
			...(input.memory || process.env.TEST_DATABASE === "memory"
				? { database: memoryDatabase() }
				: {}),
			...input.auth,
			plugins: [...(input.organization ? [organization()] : []), mollie(pluginOptions)],
		},
		{ clientOptions: { plugins: [mollieClient({ subscription: true })] } },
	);
	const signedIn = await instance.signInWithTestUser();
	const context = (await instance.auth.$context) as unknown as AuthContext;
	const api = instance.auth.api as any;
	const adapter = context.adapter;

	return {
		...instance,
		fake,
		hooks,
		authorizeReference,
		headers: signedIn.headers,
		user: signedIn.user,
		context,
		api,
		/** POST a classic Mollie webhook (`id=…`, form-encoded). */
		webhook(body: string, contentType = "application/x-www-form-urlencoded") {
			return instance.auth.handler(
				new Request(`${AUTH_URL}/mollie/webhook`, {
					method: "POST",
					headers: { "content-type": contentType },
					body,
				}),
			);
		},
		subscriptions(referenceId?: string) {
			return adapter.findMany<Subscription>({
				model: "subscription",
				where: referenceId ? [{ field: "referenceId", value: referenceId }] : [],
				sortBy: { field: "createdAt", direction: "asc" },
			});
		},
		async subscription(id: string) {
			const row = await adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "id", value: id }],
			});
			if (!row) throw new Error(`No subscription ${id}`);
			return row;
		},
		payments() {
			return adapter.findMany<MolliePaymentRecord>({ model: "molliePayment" });
		},
		operations() {
			return adapter.findMany<{ idempotencyKey: string; kind: string; status: string }>({
				model: "mollieOperation",
			});
		},
		/** Start a checkout for the signed-in user and return the created first payment. */
		async checkout(plan: string, body: Record<string, unknown> = {}) {
			const result = await api.upgradeSubscription({
				body: { plan, successUrl: "/dashboard", cancelUrl: "/pricing", ...body },
				headers: signedIn.headers,
			});
			const payment = [...fake.payments.values()].at(-1);
			if (!payment) throw new Error("No payment created");
			return { result, payment };
		},
	};
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;

/** Waits for background hooks (dispatched with `runInBackground`) to run. */
export function settle() {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Moves the clock (Date only; timers and I/O keep running). */
export function travel(to: Date | number) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(to);
}

/** A paid checkout for `plan`, processed by its webhook; returns the subscription row. */
export async function subscribe(env: TestEnv, plan = "starter"): Promise<Subscription> {
	const { payment } = await env.checkout(plan);
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	return subscription!;
}

/**
 * A one-shot gate for stopping code under test at a chosen point: the code
 * calls `hold()` (so `paused` resolves) and continues once the test calls
 * `release()`.
 */
export function gate() {
	let release!: () => void;
	let reached!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const hold = async () => {
		reached();
		await opened;
	};
	return { paused, release, hold };
}
