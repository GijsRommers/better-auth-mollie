/**
 * Payment outcomes, postponed Mollie updates and lifecycle intents: each test
 * reproduces a finding of the review of the resumable lifecycle (a70dd63).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { applyTimeTransitions } from "../../src/billing";
import { addDays, toMollieDate } from "../../src/utils";
import { PLANS, settle, setup, type TestEnv } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

function travel(to: Date | number) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(to);
}

async function subscribe(env: TestEnv, plan = "starter") {
	const { payment } = await env.checkout(plan);
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	return subscription!;
}

/** past_due after a failed renewal; returns fresh sign-in headers (sessions expire). */
async function delinquent(env: TestEnv) {
	const subscription = await subscribe(env);
	travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
	const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
	await env.webhook(`id=${failed.id}`);
	const { headers } = await env.signInWithTestUser();
	return { subscription, headers };
}

async function recoveryPayment(env: TestEnv, headers: Headers) {
	await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
	return [...env.fake.payments.values()].at(-1)!;
}

/**
 * Plans that can pause the next lookup: lets a test stop one delivery right
 * after it recorded the payment, while another delivery runs.
 */
function pausablePlans() {
	let pause: { reached: () => void; gate: Promise<void> } | null = null;
	return {
		plans: async () => {
			const current = pause;
			if (current) {
				pause = null;
				current.reached();
				await current.gate;
			}
			return PLANS;
		},
		pauseNext() {
			let release!: () => void;
			let reached!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const paused = new Promise<void>((resolve) => {
				reached = resolve;
			});
			pause = { reached, gate };
			return { paused, release };
		},
	};
}

const refundedIds = (env: TestEnv) => [...env.fake.refunds.values()].map((r) => r.paymentId);

describe("duplicate payments are refunded exactly when they are duplicates", () => {
	it("retries a duplicate's refund that failed, from the sync", async () => {
		const onDuplicatePayment = vi.fn(async () => {});
		const env = await setup({ subscription: { onDuplicatePayment } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);

		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		const response = await env.webhook(`id=${second.payment.id}`);
		// The payment itself was processed; the refund stays due for the sync.
		expect(response.status).toBe(200);
		expect(refundedIds(env)).toEqual([]);

		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([second.payment.id]);
		await env.webhook(`id=${second.payment.id}`);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([second.payment.id]);
		const records = await env.payments();
		expect(records.find((r) => r.molliePaymentId === second.payment.id)?.outcome).toBe("refunded");
		expect(records.find((r) => r.molliePaymentId === first.payment.id)?.outcome).toBe("applied");
		await settle();
		expect(onDuplicatePayment).toHaveBeenCalledTimes(1);
	});

	it("does not refund a recovery payment that a concurrent delivery of it applied", async () => {
		const pausable = pausablePlans();
		const env = await setup({ subscription: { plans: pausable.plans } });
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		env.fake.completePayment(recovery.id, "paid");

		// Delivery A is applying the payment; B arrives meanwhile. They never
		// interleave: B is told to come back (Mollie retries), and its retry
		// finds the payment applied.
		const { paused, release } = pausable.pauseNext();
		const deliveryA = env.webhook(`id=${recovery.id}`);
		await paused;
		expect((await env.webhook(`id=${recovery.id}`)).status).toBe(409);
		release();
		expect((await deliveryA).status).toBe(200);
		expect((await env.webhook(`id=${recovery.id}`)).status).toBe(200);

		expect(refundedIds(env)).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ status: "active", appliedPaymentId: recovery.id });
	});

	it("applies exactly one of two checkouts paid at the same time and refunds the other", async () => {
		const pausable = pausablePlans();
		const env = await setup({ subscription: { plans: pausable.plans } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");

		// The second checkout's delivery is being applied when the first arrives.
		const { paused, release } = pausable.pauseNext();
		const late = env.webhook(`id=${second.payment.id}`);
		await paused;
		expect((await env.webhook(`id=${first.payment.id}`)).status).toBe(409);
		release();
		await late;
		// Mollie retries the first delivery: that checkout pays for nothing now.
		await env.webhook(`id=${first.payment.id}`);

		expect(refundedIds(env)).toEqual([first.payment.id]);
		expect((await env.subscriptions())[0]).toMatchObject({ status: "active", plan: "business" });
	});

	it("does not invoice a duplicate that is refunded", async () => {
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: {
				salesInvoices: {
					enabled: true,
					getRecipient: () => ({
						type: "consumer",
						givenName: "Test",
						familyName: "User",
						email: "test@example.com",
						streetAndNumber: "Keizersgracht 1",
						postalCode: "1015 CJ",
						city: "Amsterdam",
						country: "NL",
						locale: "nl_NL",
					}),
				},
			},
		});
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		await env.webhook(`id=${second.payment.id}`);
		await settle();
		await syncMollieSubscriptions(env.auth as never);
		const invoiced = [...env.fake.salesInvoices.values()].map(
			(invoice: any) => (invoice.request ?? invoice).paymentDetails?.sourceReference,
		);
		expect(invoiced).toEqual([first.payment.id]);
	});
});

describe("Mollie follows every change, and never collects twice for the same time", () => {
	it("does not replace a Mollie subscription while one of its charges is in progress", async () => {
		let rate = "21.00";
		const env = await setup({ subscription: { tax: { calculate: () => ({ rate }) } } });
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		rate = "9.00";

		await syncMollieSubscriptions(env.auth as never);
		const customerId = subscription.mollieCustomerId!;
		expect(env.fake.activeSubscriptionsFor(customerId).map((s) => s.id)).toEqual([
			subscription.mollieSubscriptionId,
		]);
		expect((await env.subscription(subscription.id)).mollieSyncNeeded).toBe(true);

		env.fake.completePayment(charge.id, "paid");
		await env.webhook(`id=${charge.id}`);
		const row = await env.subscription(subscription.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(customerId);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({
			amount: { value: "10.85" },
			startDate: toMollieDate(new Date(row.periodEnd!)),
		});
		expect(row.mollieSyncNeeded).toBe(false);
		expect(refundedIds(env)).toEqual([]);
	});

	it("cancels a lost replacement when the plan change is undone", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		// The starter replacement exists at Mollie but was never recorded; undo.
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });

		const row = await env.subscription(subscription.id);
		expect(row.pendingPlan).toBeFalsy();
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({ metadata: { plan: "business" } });
	});

	it("brings Mollie in line after a recovery right away, not at the next period end", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		env.fake.completePayment(recovery.id, "paid");
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.webhook(`id=${recovery.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");
		// The old Mollie subscription, on the old mandate, is still running.
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");

		travel(Date.now() + 2 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const row = await env.subscription(subscription.id);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]?.mandateId).toBe(row.mollieMandateId);
		expect(row.mollieSyncNeeded).toBe(false);
	});

	it("never resumes billing after a cancellation that was interrupted at Mollie", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		// Mollie cancels, but the response is lost and checking it fails too.
		env.fake.loseNextResponse("subscriptions.cancel");
		env.fake.failNext("subscriptions.get", new TypeError("fetch failed"));
		await env.api
			.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers })
			.catch(() => {});

		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
		});
	});

	it("keeps taxing with the customer type chosen at checkout", async () => {
		const env = await setup({
			subscription: {
				tax: {
					calculate: ({ customerType }) =>
						customerType === "user"
							? { rate: "21.00" }
							: { rate: "0.00", reverseCharge: true, country: "BE" },
				},
			},
		});
		const subscription = await subscribe(env);
		// The user record is gone (e.g. deleted); the subscription runs on, and
		// its price must not turn into a business price.
		await env.context.adapter.delete({
			model: "user",
			where: [{ field: "id", value: subscription.referenceId }],
		});
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => [s.id, s.amount.value])).toEqual([
			[subscription.mollieSubscriptionId, "12.04"],
		]);
	});
});

describe("re-check of 94c806f: cancellation, coverage and compensation", () => {
	it("keeps retrying a failed cancellation after the period has ended", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");

		// The first sync only runs after the period ended.
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ status: "canceled", mollieSyncNeeded: false });
	});

	it("stops a lost replacement when the customer cancels", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toHaveLength(1);

		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
	});

	it("applies a renewal whose webhook is late before replacing billing", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		// Mollie charged the renewal; its webhook has not arrived.
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers });

		const row = await env.subscription(subscription.id);
		expect(row.plan).toBe("business");
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]?.startDate).toBe(toMollieDate(new Date(row.periodEnd!)));
		expect(refundedIds(env)).toEqual([]);
	});

	it("does not adopt a replacement made for a period a renewal just extended", async () => {
		let rate = "21.00";
		let pause: (() => Promise<void>) | null = null;
		const env = await setup({
			subscription: {
				tax: {
					calculate: async () => {
						const current = pause;
						pause = null;
						if (current) await current();
						return { rate };
					},
				},
			},
		});
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		rate = "9.00";

		let release!: () => void;
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		pause = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				reached();
			});
		const sync = syncMollieSubscriptions(env.auth as never);
		await paused;
		// While the sync works out the new price, the renewal is paid.
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${charge.id}`);
		release();
		await sync;

		const row = await env.subscription(subscription.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({
			amount: { value: "10.85" },
			startDate: toMollieDate(new Date(row.periodEnd!)),
		});
		expect(refundedIds(env)).toEqual([]);
	});

	it("refunds a pro-rata charge whose upgrade lost its lock, even if the refund fails at first", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		let reached!: () => void;
		const charged = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		env.fake.afterNextCreate("payments.create", async () => {
			reached();
			await gate;
		});
		const upgrade = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await charged;
		// The upgrade stalls after charging, past its lease; another change takes over.
		travel(Date.now() + 3 * 60_000);
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "yearly" }, headers });
		release();
		await upgrade;

		const proration = [...env.fake.payments.values()].find(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		)!;
		expect(refundedIds(env)).toEqual([]);
		// The charge settles later; its first refund attempt fails.
		if (proration.status !== "paid") env.fake.completePayment(proration.id, "paid");
		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		await env.webhook(`id=${proration.id}`);
		expect(refundedIds(env)).toEqual([]);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([proration.id]);
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	it("refunds a pro-rata charge whose upgrade was never recorded (process stopped)", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		// Charged by an upgrade whose process stopped before changing the plan.
		const proration = await env.fake.client.payments.create({
			idempotencyKey: "crashed-upgrade",
			paymentRequest: {
				amount: { currency: "EUR", value: "39.05" },
				description: "business: upgrade for the rest of this period",
				sequenceType: "recurring",
				customerId: subscription.mollieCustomerId!,
				mandateId: subscription.mollieMandateId!,
				metadata: { subscriptionId: subscription.id, plan: "business", purpose: "proration" },
			},
		} as never);
		env.fake.completePayment(proration.id, "paid");
		await env.webhook(`id=${proration.id}`);
		expect(refundedIds(env)).toEqual([]);

		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([proration.id]);
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	it("does not let a recovery payment undo a later cancellation", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });

		env.fake.completePayment(recovery.id, "paid");
		await env.webhook(`id=${recovery.id}`);
		const row = await env.subscription(subscription.id);
		expect(row.cancelAtPeriodEnd).toBe(true);
		expect(row.status).not.toBe("active");
		expect(refundedIds(env)).toEqual([recovery.id]);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
	});

	it("starts a new subscription, not a recovery, after a delinquent one was canceled", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });

		expect((await env.subscription(subscription.id)).status).toBe("canceled");
		const latest = [...env.fake.payments.values()].at(-1)!;
		expect(metadataPurpose(latest)).toBe("checkout");
		expect((latest.metadata as { subscriptionId: string }).subscriptionId).not.toBe(
			subscription.id,
		);
	});
});

function metadataPurpose(payment: { metadata?: unknown }) {
	return (payment.metadata as { purpose?: string } | undefined)?.purpose;
}

describe("re-check of 36f27be: shared charges, unseen charges, stale transitions", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	/** An upgrade to business that stalls right after charging, until released. */
	async function stalledUpgrade(env: TestEnv) {
		let reached!: () => void;
		const charged = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		env.fake.afterNextCreate("payments.create", async () => {
			reached();
			await gate;
		});
		const upgrade = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await charged;
		travel(Date.now() + 3 * 60_000);
		return { upgrade, release };
	}

	async function settleAll(env: TestEnv) {
		for (const payment of prorations(env)) {
			if (payment.status === "open") env.fake.completePayment(payment.id, "paid");
			await env.webhook(`id=${payment.id}`);
		}
		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
	}

	it("never refunds the charge of an upgrade that took over a stalled one", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		const stalled = await stalledUpgrade(env);
		// The same upgrade again, after the first one's lease expired.
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers });
		stalled.release();
		await stalled.upgrade;
		await settleAll(env);

		const row = await env.subscription(subscription.id);
		expect(row.plan).toBe("business");
		const records = await env.payments();
		const applied = records.find((r) => r.molliePaymentId === row.appliedPaymentId)!;
		expect(applied.outcome).toBe("applied");
		expect(refundedIds(env)).not.toContain(applied.molliePaymentId);
		// Exactly one pro-rata charge is kept.
		const kept = prorations(env).filter((p) => !refundedIds(env).includes(p.id));
		expect(kept.map((p) => p.id)).toEqual([applied.molliePaymentId]);
	});

	it("never grants an upgrade on a charge that was refunded, however often it was retried", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		for (let i = 0; i < 3; i++) {
			const stalled = await stalledUpgrade(env);
			const { headers } = await env.signInWithTestUser();
			await env.api.upgradeSubscription({ body: { plan: "yearly" }, headers });
			stalled.release();
			await stalled.upgrade;
			// Undo the scheduled change, so the next attempt is an upgrade again.
			await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
		}
		const compensated = prorations(env).map((p) => p.id);
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers });

		const row = await env.subscription(subscription.id);
		expect(row.plan).toBe("business");
		expect(compensated).not.toContain(row.appliedPaymentId);
		const record = (await env.payments()).find((r) => r.molliePaymentId === row.appliedPaymentId);
		expect(record?.outcome).not.toMatch(/duplicate|refunded/);
	});

	it("refunds a renewal Mollie collected after a failed cancellation, without a webhook", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");

		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([charge.id]);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "canceled",
			mollieSyncNeeded: false,
		});
	});

	it("keeps watching a charge that is still pending when billing is cleaned up", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");

		await syncMollieSubscriptions(env.auth as never);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "canceled",
			mollieSyncNeeded: true,
		});
		env.fake.completePayment(charge.id, "paid");
		travel(Date.now() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([charge.id]);
		expect((await env.subscription(subscription.id)).mollieSyncNeeded).toBe(false);
	});

	it("does not end a subscription that was restored after it was read", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		const stale = await env.subscription(subscription.id);
		await env.api.restoreSubscription({ body: {}, headers: env.headers });

		// A request that read the canceling row resumes after the period ended.
		await applyTimeTransitions(
			{ context: env.context } as never,
			{ mollieClient: env.fake.client, subscription: { enabled: true, plans: PLANS } } as never,
			stale,
			new Date(new Date(subscription.periodEnd!).getTime() + 3_600_000),
		);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: false,
		});
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toHaveLength(1);
	});
});

describe("re-check of 8ede203: lost charges, stalled writers, serialized payments", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	/** Pauses the first adapter `incrementOne` matching `when`, until released. */
	function pauseWrite(env: TestEnv, when: (args: any) => boolean) {
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let armed = true;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (armed && when(args)) {
				armed = false;
				reached();
				await gate;
			}
			return original(args);
		};
		return { paused, release, restore: () => (adapter.incrementOne = original) };
	}

	async function until(condition: () => boolean, promise?: Promise<unknown>) {
		let done = false;
		promise?.finally(() => {
			done = true;
		});
		for (let i = 0; i < 500 && !condition() && !done; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it("refunds a pro-rata charge whose creation response was lost, after the upgrade is retried", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		env.fake.afterNextCreate("payments.create", () => {
			throw new TypeError("socket hang up");
		});
		await expect(
			env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers }),
		).rejects.toBeTruthy();
		const [lost] = prorations(env);
		expect((await env.payments()).map((r) => r.molliePaymentId)).not.toContain(lost!.id);

		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		for (const payment of prorations(env)) {
			if (payment.status === "open") env.fake.completePayment(payment.id, "paid");
		}
		// No webhooks: the lost charge is only found by the sync.
		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		const row = await env.subscription(subscription.id);
		expect(row.plan).toBe("business");
		expect(row.appliedPaymentId).not.toBe(lost!.id);
		expect(refundedIds(env)).toEqual([lost!.id]);
	});

	it("never grants an upgrade whose charge was refunded while it stalled after its last check", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		// Stall right after the upgrade's last lease check, before it records the plan.
		const stall = pauseWrite(
			env,
			(args) => args.model === "molliePayment" && args.set?.outcome === "applied",
		);
		const upgrade = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await stall.paused;
		const [proration] = prorations(env);
		env.fake.completePayment(proration!.id, "paid");
		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([proration!.id]);

		stall.release();
		await upgrade;
		stall.restore();
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	it("refunds a charge that a canceled stray Mollie subscription completes later", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		const customerId = subscription.mollieCustomerId!;
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const [stray] = env.fake.activeSubscriptionsFor(customerId);
		const charge = env.fake.chargeSubscription(stray!.id, "open");

		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect(env.fake.activeSubscriptionsFor(customerId)).toEqual([]);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).mollieSyncNeeded).toBe(true);

		env.fake.completePayment(charge.id, "paid");
		travel(Date.now() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([charge.id]);
		expect((await env.subscription(subscription.id)).mollieSyncNeeded).toBe(false);
	});

	it("still finds a stray subscription's charge when cleanup stopped right after canceling it", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		const customerId = subscription.mollieCustomerId!;
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const [stray] = env.fake.activeSubscriptionsFor(customerId);
		const charge = env.fake.chargeSubscription(stray!.id, "paid");

		// The process stops right after the stray subscription was canceled.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		adapter.incrementOne = async (args: any) => {
			const result = await original(args);
			const key = args.where?.find((w: any) => w.field === "idempotencyKey")?.value;
			if (args.set?.status === "succeeded" && String(key).startsWith(`cancel:${stray!.id}`)) {
				adapter.incrementOne = original;
				throw new Error("process stopped");
			}
			return result;
		};
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		adapter.incrementOne = original;
		expect(env.fake.subscriptions.get(stray!.id)?.status).toBe("canceled");

		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([charge.id]);
	});

	it("never extends access with a renewal that is being refunded, even across a restore", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		travel(periodEnd.getTime() - 3_600_000);
		const { headers } = await env.signInWithTestUser();
		// Mollie still collects the renewal (stopping it failed).
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");

		// Delivery A decides the renewal pays for a canceled period...
		const classify = pauseWrite(
			env,
			(args) => args.model === "molliePayment" && args.set?.outcome === "duplicate",
		);
		const deliveryA = env.webhook(`id=${renewal.id}`);
		await classify.paused;
		// ...while the customer restores and Mollie delivers the payment again.
		const restoredDuring = await env.api
			.restoreSubscription({ body: {}, headers })
			.catch((error: unknown) => error);
		const gets = env.fake.callsTo("subscriptions.get").length;
		const releaseGet = env.fake.hold("subscriptions.get", "arrival");
		const deliveryB = env.webhook(`id=${renewal.id}`);
		await until(() => env.fake.callsTo("subscriptions.get").length > gets, deliveryB);
		classify.release();
		await deliveryA;
		releaseGet();
		await deliveryB;
		classify.restore();
		if (restoredDuring instanceof Error) {
			await env.api.restoreSubscription({ body: {}, headers });
		}

		expect(refundedIds(env)).toEqual([renewal.id]);
		const row = await env.subscription(subscription.id);
		expect(row.appliedPaymentId).not.toBe(renewal.id);
		expect(new Date(row.periodEnd!).getTime()).toBe(periodEnd.getTime());
		expect(row.cancelAtPeriodEnd).toBe(false);
		// Restored: Mollie charges again when the paid period ends, not a month later.
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]?.nextPaymentDate).toBe(toMollieDate(periodEnd));
	});
});

describe("re-check of 0830e45: takeover, recovery bookkeeping, short intervals", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	function pauseWrite(env: TestEnv, when: (args: any) => boolean) {
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let armed = true;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (armed && when(args)) {
				armed = false;
				reached();
				await gate;
			}
			return original(args);
		};
		return { paused, release, restore: () => (adapter.incrementOne = original) };
	}

	it("never lets a processor whose lease expired refund a payment the next holder applies", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		travel(periodEnd.getTime() - 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");

		// A decides the renewal pays for a canceled period, then stalls past its lease.
		const classify = pauseWrite(
			env,
			(args) => args.model === "molliePayment" && args.set?.outcome === "duplicate",
		);
		const deliveryA = env.webhook(`id=${renewal.id}`);
		await classify.paused;
		travel(Date.now() + 3 * 60_000);
		const { headers } = await env.signInWithTestUser();

		// The restore takes over, applies the renewal, and stalls before recording that.
		const apply = pauseWrite(
			env,
			(args) => args.model === "molliePayment" && args.set?.outcome === "applied",
		);
		const restore = env.api.restoreSubscription({ body: {}, headers });
		await apply.paused;
		classify.release();
		await deliveryA;
		apply.release();
		await restore;
		apply.restore();
		classify.restore();

		expect(refundedIds(env)).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ cancelAtPeriodEnd: false, appliedPaymentId: renewal.id });
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const record = (await env.payments()).find((r) => r.molliePaymentId === renewal.id);
		expect(record?.outcome).toBe("applied");
		// The stalled processor's claim does not block anyone after it.
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(200);
	});

	it("keeps an abandoned pro-rata charge outstanding when recovering it fails halfway", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		env.fake.afterNextCreate("payments.create", () => {
			throw new TypeError("socket hang up");
		});
		await expect(
			env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers }),
		).rejects.toBeTruthy();
		const [lost] = prorations(env);
		env.fake.completePayment(lost!.id, "paid");

		// First sync: found at Mollie, but fetching it fails.
		travel(Date.now() + 5 * 60_000);
		env.fake.failNext("payments.get", new TypeError("fetch failed"));
		await syncMollieSubscriptions(env.auth as never);
		// Second sync: recorded, but the subscription is busy.
		travel(Date.now() + 15 * 60_000);
		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: subscription.id }],
			update: { lockToken: "someone-else", lockedUntil: new Date(Date.now() + 60_000) },
		});
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([]);
		// Later syncs process it like any recorded payment.
		travel(Date.now() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([lost!.id]);
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	for (const [interval, days] of [
		["1 day", 1],
		["3 days", 3],
	] as const) {
		it(`does not skip a ${interval} cycle when keeping a running Mollie subscription`, async () => {
			const env = await setup({
				subscription: {
					plans: [...PLANS, { name: "short", amount: "1.00", interval }],
				},
			});
			const subscription = await subscribe(env, "short");
			const periodEnd = new Date(subscription.periodEnd!);
			env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
			await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
			// Mollie moved on by one cycle (e.g. a renewal that was refunded).
			const remote = env.fake.subscriptions.get(subscription.mollieSubscriptionId!)!;
			remote.nextPaymentDate = toMollieDate(addDays(periodEnd, days));

			await env.api.restoreSubscription({ body: {}, headers: env.headers });
			const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
			expect(active).toHaveLength(1);
			expect(active[0]?.nextPaymentDate).toBe(toMollieDate(periodEnd));
		});
	}
});

describe("re-check of 5d94fe8: older records, hooks of recovered charges, ended subscriptions", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	async function loseUpgradeCharge(env: TestEnv) {
		env.fake.afterNextCreate("payments.create", () => {
			throw new TypeError("socket hang up");
		});
		await expect(
			env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers }),
		).rejects.toBeTruthy();
		return prorations(env)[0]!;
	}

	it("processes payments and locks recorded before the serials existed", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		await env.webhook(`id=${renewal.id}`);
		// As an older version left them: no serials.
		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: subscription.id }],
			update: { lockSerial: null },
		});
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: renewal.id }],
			update: { claimSerial: null },
		});

		env.fake.completePayment(renewal.id, "paid");
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(200);
		const row = await env.subscription(subscription.id);
		expect(row.appliedPaymentId).toBe(renewal.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		expect(typeof row.lockSerial).toBe("number");
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(200);
	});

	it("runs the paid hook of a recovered charge, then refunds it", async () => {
		const onPaymentPaid = vi.fn(async (_data: any) => {});
		const env = await setup({ subscription: { onPaymentPaid } });
		await subscribe(env, "starter");
		await settle();
		onPaymentPaid.mockClear();
		const lost = await loseUpgradeCharge(env);
		env.fake.completePayment(lost.id, "paid");

		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onPaymentPaid.mock.calls.map(([data]) => data.payment.id)).toEqual([lost.id]);
		expect(refundedIds(env)).toEqual([lost.id]);
	});

	it("runs the failure hook of a recovered charge that failed, without making anything past due", async () => {
		const onPaymentFailed = vi.fn(async (_data: any) => {});
		const env = await setup({ subscription: { onPaymentFailed } });
		const subscription = await subscribe(env, "starter");
		const lost = await loseUpgradeCharge(env);
		env.fake.completePayment(lost.id, "failed");

		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onPaymentFailed.mock.calls.map(([data]) => data.payment.id)).toEqual([lost.id]);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			plan: "starter",
		});
	});

	it("finishes an unresolved charge of a subscription that has ended", async () => {
		const onPaymentPaid = vi.fn(async (_data: any) => {});
		const env = await setup({ subscription: { onPaymentPaid } });
		const subscription = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const [proration] = prorations(env);
		expect(proration?.status).toBe("open");
		// The subscription ended, with nothing else left to do, before the charge settled.
		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: subscription.id }],
			update: { status: "canceled", mollieSyncNeeded: false },
		});
		await settle();
		onPaymentPaid.mockClear();
		env.fake.completePayment(proration!.id, "paid");

		await syncMollieSubscriptions(env.auth as never);
		await settle();
		const record = (await env.payments()).find((r) => r.molliePaymentId === proration!.id);
		expect(record).toMatchObject({ status: "paid", outcome: "applied" });
		expect(onPaymentPaid.mock.calls.map(([data]) => data.payment.id)).toEqual([proration!.id]);
		expect(refundedIds(env)).toEqual([]);
	});
});

describe("re-check of 933ba33: successive upgrades, hooks when a refund fails", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	it("makes a subscription past due when an earlier upgrade's charge fails after a later upgrade", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "pro" }, headers: env.headers });
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const [first, second] = prorations(env);
		expect((await env.subscription(subscription.id)).appliedPaymentId).toBe(second!.id);

		env.fake.completePayment(second!.id, "paid");
		await env.webhook(`id=${second!.id}`);
		env.fake.completePayment(first!.id, "failed");
		await env.webhook(`id=${first!.id}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "past_due",
			plan: "business",
		});
	});

	it("still runs the paid hook of a duplicate whose refund fails", async () => {
		const onPaymentPaid = vi.fn(async (_data: any) => {});
		const env = await setup({ subscription: { onPaymentPaid } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		await settle();
		onPaymentPaid.mockClear();

		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		await env.webhook(`id=${second.payment.id}`);
		await settle();
		expect(onPaymentPaid.mock.calls.map(([data]) => data.payment.id)).toEqual([second.payment.id]);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([second.payment.id]);
	});
});

describe("re-check of f77df6d: failures are applied even if processing stopped", () => {
	const prorations = (env: TestEnv) =>
		[...env.fake.payments.values()].filter((p) => metadataPurpose(p) === "proration");

	it("applies a failed charge recorded right before the process stopped", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "pro" }, headers: env.headers });
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const [first, second] = prorations(env);
		env.fake.completePayment(second!.id, "paid");
		env.fake.completePayment(first!.id, "failed");

		// No webhooks. The sync records the failure, then the process stops.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		adapter.incrementOne = async (args: any) => {
			const result = await original(args);
			if (args.model === "molliePayment" && args.set?.status === "failed") {
				adapter.incrementOne = original;
				throw new Error("process stopped");
			}
			return result;
		};
		await syncMollieSubscriptions(env.auth as never);
		adapter.incrementOne = original;
		const recorded = (await env.payments()).find((r) => r.molliePaymentId === first!.id);
		expect(recorded?.status).toBe("failed");

		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		const handled = (await env.payments()).find((r) => r.molliePaymentId === first!.id);
		expect(handled?.outcome).toBe("handled");
		// Delivered again later: nothing changes twice.
		await env.webhook(`id=${first!.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
	});
});

describe("re-check of 0d722f4: failure consequences under lease loss and replay", () => {
	it("keeps a failure to be done when its consequence was refused because the lease expired", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");

		// The delivery claims the payment, then stalls past its lease.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			const result = await original(args);
			if (args.model === "molliePayment" && args.set && "claimSerial" in args.set) {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return result;
		};
		const delivery = env.webhook(`id=${failed.id}`);
		await paused;
		travel(Date.now() + 3 * 60_000);
		release();
		await delivery;
		adapter.incrementOne = original;
		expect((await env.payments()).find((r) => r.molliePaymentId === failed.id)?.outcome).not.toBe(
			"handled",
		);

		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		expect((await env.payments()).find((r) => r.molliePaymentId === failed.id)?.outcome).toBe(
			"handled",
		);
	});

	it("does not make a subscription past due again when its cycle was paid after the failure", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");

		// The failure is applied, then the process stops before recording that.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		adapter.incrementOne = async (args: any) => {
			const result = await original(args);
			if (args.model === "subscription" && args.set?.status === "past_due") {
				adapter.incrementOne = original;
				throw new Error("process stopped");
			}
			return result;
		};
		await env.webhook(`id=${failed.id}`);
		adapter.incrementOne = original;
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		// A retry for the same cycle is paid.
		const retry = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${retry.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");

		// The failure is processed again: that cycle is paid, nothing changes.
		await env.webhook(`id=${failed.id}`);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});
});

describe("re-check of 8640b0f: vanished Mollie subscriptions, overdue races", () => {
	it("keeps processing a failed renewal whose Mollie subscription is gone, and the sync moving", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		await env.webhook(`id=${failed.id}`);
		// Mollie no longer knows the subscription (e.g. test data was reset).
		env.fake.subscriptions.delete(subscription.mollieSubscriptionId!);
		env.fake.completePayment(failed.id, "failed");

		const first = await syncMollieSubscriptions(env.auth as never);
		expect(first.errors).toEqual([]);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		expect((await env.payments()).find((r) => r.molliePaymentId === failed.id)?.outcome).toBe(
			"handled",
		);
		expect((await syncMollieSubscriptions(env.auth as never)).errors).toEqual([]);
	});

	it("never lets the sync's overdue decision overwrite a renewal", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(addDays(periodEnd, 15));

		// The sync decides the subscription is overdue; meanwhile the renewal lands.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (args.model === "subscription" && args.set?.status === "past_due") {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		const sync = syncMollieSubscriptions(env.auth as never);
		await paused;
		// The sync holds the subscription: the renewal's delivery is told to come
		// back (Mollie retries) instead of being overwritten.
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(409);
		release();
		await sync;
		adapter.incrementOne = original;
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(200);

		const row = await env.subscription(subscription.id);
		expect(row.status).toBe("active");
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
	});
});

describe("re-check of ff9b5be: vanished subscriptions, checkout races", () => {
	/** Pauses the first matching write (adapter `update` or `incrementOne`) until released. */
	function pauseSubscriptionWrite(env: TestEnv, when: (set: any) => boolean) {
		const adapter = env.context.adapter as any;
		const originals = {
			update: adapter.update.bind(adapter),
			incrementOne: adapter.incrementOne.bind(adapter),
		};
		let armed = true;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const wrap = (name: "update" | "incrementOne") => async (args: any) => {
			const set = name === "update" ? args.update : args.set;
			if (armed && args.model === "subscription" && set && when(set)) {
				armed = false;
				reached();
				await gate;
			}
			return originals[name](args);
		};
		adapter.update = wrap("update");
		adapter.incrementOne = wrap("incrementOne");
		return {
			paused,
			release,
			restore: () => {
				adapter.update = originals.update;
				adapter.incrementOne = originals.incrementOne;
			},
		};
	}

	it("judges a replayed failure by the paid-through date when the Mollie subscription is gone", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		adapter.incrementOne = async (args: any) => {
			const result = await original(args);
			if (args.model === "subscription" && args.set?.status === "past_due") {
				adapter.incrementOne = original;
				throw new Error("process stopped");
			}
			return result;
		};
		await env.webhook(`id=${failed.id}`);
		adapter.incrementOne = original;
		const retry = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${retry.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");

		env.fake.subscriptions.delete(subscription.mollieSubscriptionId!);
		await env.webhook(`id=${failed.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("applies a paid renewal whose Mollie subscription is gone, without stopping the sync", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		await env.webhook(`id=${renewal.id}`);
		env.fake.subscriptions.delete(subscription.mollieSubscriptionId!);
		env.fake.completePayment(renewal.id, "paid");

		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row.appliedPaymentId).toBe(renewal.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
	});

	it("never grants a plan by reusing a checkout that was activated meanwhile", async () => {
		const env = await setup();
		const { payment: starter } = await env.checkout("starter");
		env.fake.completePayment(starter.id, "paid");

		// A checkout for business starts on the same pending row and stalls
		// right before switching its plan; meanwhile the starter payment lands.
		const stall = pauseSubscriptionWrite(env, (set) => set.plan === "business");
		const business = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await stall.paused;
		await env.webhook(`id=${starter.id}`);
		stall.release();
		await business;
		stall.restore();
		await env.webhook(`id=${starter.id}`);

		const [row] = await env.subscriptions();
		expect(row).toMatchObject({ status: "active", plan: "starter" });
		const [remote] = env.fake.activeSubscriptionsFor(row!.mollieCustomerId!);
		expect(remote?.metadata).toMatchObject({ plan: "starter" });
	});

	it("never expires a checkout row while a new checkout is being issued for it", async () => {
		const env = await setup();
		const { payment: first } = await env.checkout("starter");
		env.fake.completePayment(first.id, "failed");

		// The sync finds the failed attempt and is about to expire the row...
		const stall = pauseSubscriptionWrite(env, (set) => set.status === "incomplete_expired");
		const sync = syncMollieSubscriptions(env.auth as never);
		await stall.paused;
		// ...while the customer starts another checkout.
		const during = await env.api
			.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers })
			.catch((error: unknown) => error);
		stall.release();
		await sync;
		stall.restore();
		if (during instanceof Error) {
			await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		}

		const latest = [...env.fake.payments.values()].at(-1)!;
		expect(latest.id).not.toBe(first.id);
		env.fake.completePayment(latest.id, "paid");
		await env.webhook(`id=${latest.id}`);
		expect(refundedIds(env)).toEqual([]);
		const active = (await env.subscriptions()).filter((s) => s.status === "active");
		expect(active).toHaveLength(1);
	});
});

describe("re-check of bfe76d6: uncertain discovery, replacement rows, unlocked writers, contention", () => {
	async function until(condition: () => boolean) {
		for (let i = 0; i < 500 && !condition(); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it("never makes a subscription delinquent while its charges could not be checked", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(addDays(periodEnd, 15));
		// The renewal was paid at Mollie; its webhook never came, and looking it up fails.
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		env.fake.failNext("subscriptions.listPayments", new TypeError("fetch failed"));
		env.fake.failNext("customers.listPayments", new TypeError("fetch failed"));

		const first = await syncMollieSubscriptions(env.auth as never);
		expect(first.errors.length).toBeGreaterThan(0);
		expect((await env.subscription(subscription.id)).status).toBe("active");

		await syncMollieSubscriptions(env.auth as never);
		const row = await env.subscription(subscription.id);
		expect(row.status).toBe("active");
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
	});

	it("issues a checkout for a replacement row under that row's own lock", async () => {
		const env = await setup();
		const { payment: abandoned } = await env.checkout("starter");
		env.fake.completePayment(abandoned.id, "failed");

		// Request A finds the row expired and creates a replacement, then stalls.
		const adapter = env.context.adapter as any;
		const original = adapter.create.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.create = async (args: any) => {
			const result = await original(args);
			if (args.model === "subscription") {
				adapter.create = original;
				reached();
				await gate;
			}
			return result;
		};
		const requestA = env.api
			.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers })
			.catch((error: unknown) => error);
		await paused;
		// Meanwhile B checks out on the replacement, and that attempt fails.
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const attemptB = [...env.fake.payments.values()].at(-1)!;
		env.fake.completePayment(attemptB.id, "failed");
		await env.webhook(`id=${attemptB.id}`);
		release();
		await requestA;
		adapter.create = original;

		const issuedA = [...env.fake.payments.values()].at(-1)!;
		expect(issuedA.id).not.toBe(attemptB.id);
		env.fake.completePayment(issuedA.id, "paid");
		await env.webhook(`id=${issuedA.id}`);
		expect(refundedIds(env)).toEqual([]);
		expect((await env.subscriptions()).filter((s) => s.status === "active")).toHaveLength(1);
	});

	it("never lets a stale Mollie subscription webhook undo a newer plan change", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		// The merchant canceled the Mollie subscription; its webhook is being processed.
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "canceled");
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (args.model === "subscription" && args.set?.cancelAtPeriodEnd === true) {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		const webhook = env.webhook(`id=${subscription.mollieSubscriptionId}`);
		await paused;
		// Meanwhile the customer schedules a downgrade (creating its Mollie
		// subscription fails for now).
		env.fake.failNext("subscriptions.create", new TypeError("fetch failed"));
		const during = await env.api
			.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers })
			.catch((error: unknown) => error);
		release();
		await webhook;
		adapter.incrementOne = original;
		if (during instanceof Error) {
			await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		}

		expect(await env.subscription(subscription.id)).toMatchObject({
			pendingPlan: "starter",
			cancelAtPeriodEnd: false,
		});
	});

	it("does not cancel a Mollie subscription it just adopted when finishing the sync fails", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const [adoptable] = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		travel(Date.now() + 15 * 60_000);

		// Adopting succeeds, recording that Mollie is in line fails.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		adapter.incrementOne = async (args: any) => {
			if (args.model === "subscription" && args.set?.mollieSyncNeeded === false) {
				adapter.incrementOne = original;
				throw new Error("database unavailable");
			}
			return original(args);
		};
		await syncMollieSubscriptions(env.auth as never);
		adapter.incrementOne = original;

		expect((await env.subscription(subscription.id)).mollieSubscriptionId).toBe(adoptable!.id);
		expect(env.fake.subscriptions.get(adoptable!.id)?.status).toBe("active");
	});

	it("does not hold the subscription while the sync looks up charges at Mollie", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		const { headers } = await env.signInWithTestUser();
		const lookups = env.fake.callsTo("customers.listPayments").length;
		const releaseLookup = env.fake.hold("customers.listPayments", "arrival");
		const sync = syncMollieSubscriptions(env.auth as never);
		await until(() => env.fake.callsTo("customers.listPayments").length > lookups);

		// A slow lookup does not block the customer.
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });
		releaseLookup();
		await sync;
		expect((await env.subscription(subscription.id)).cancelAtPeriodEnd).toBe(true);
	});
});

describe("re-check of 313584a: stale Mollie status, concurrent replacements, listing", () => {
	it("never lets a suspended status read before a paid renewal make it past due", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "suspended");
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");

		// The renewal is being applied when Mollie's subscription webhook arrives.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (args.model === "molliePayment" && args.set?.outcome === "applied") {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		const deliveryR = env.webhook(`id=${renewal.id}`);
		await paused;
		const deliveryW = env.webhook(`id=${subscription.mollieSubscriptionId}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await deliveryR;
		await deliveryW;
		adapter.incrementOne = original;

		const row = await env.subscription(subscription.id);
		expect(row.status).toBe("active");
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
	});

	it("shares one new row between checkouts that both replace an expired one", async () => {
		let stall: { reached: () => void; gate: Promise<void> } | null = null;
		const env = await setup({
			subscription: {
				tax: {
					calculate: async () => {
						const current = stall;
						stall = null;
						if (current) {
							current.reached();
							await current.gate;
						}
						return { rate: "21.00" };
					},
				},
			},
		});
		const { payment: abandoned } = await env.checkout("starter");
		env.fake.completePayment(abandoned.id, "failed");

		// B picks the pending row, then stalls before locking it...
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			stall = { reached: resolve, gate };
		});
		const requestB = env.api
			.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers })
			.catch((error: unknown) => error);
		await paused;
		// ...while A finds it expired and replaces it.
		const requestA = await env.api.upgradeSubscription({
			body: { plan: "starter" },
			headers: env.headers,
		});
		release();
		const resultB = (await requestB) as { url?: string };

		const pending = (await env.subscriptions()).filter((s) => s.status === "incomplete");
		expect(pending).toHaveLength(1);
		expect(resultB.url).toBe(requestA.url);
	});

	it("refunds a checkout for a second subscription instead of starting it", async () => {
		const env = await setup();
		const first = await subscribe(env, "starter");
		// A second pending row for the same reference (e.g. left by an older version).
		const second = await env.context.adapter.create<any, any>({
			model: "subscription",
			data: {
				referenceId: first.referenceId,
				plan: "business",
				status: "incomplete",
				mollieCustomerId: first.mollieCustomerId,
				customerType: "user",
				cancelAtPeriodEnd: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const payment = await env.fake.client.payments.create({
			idempotencyKey: "second-row",
			paymentRequest: {
				amount: { currency: "EUR", value: "49.00" },
				description: "business",
				sequenceType: "first",
				customerId: first.mollieCustomerId!,
				redirectUrl: "https://app.example.com/done",
				metadata: { subscriptionId: second.id, plan: "business", purpose: "checkout" },
			},
		} as never);
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);

		expect(refundedIds(env)).toEqual([payment.id]);
		expect((await env.subscription(second.id)).status).toBe("incomplete");
		expect(env.fake.activeSubscriptionsFor(first.mollieCustomerId!)).toHaveLength(1);
	});

	it("does not list a past-due subscription whose grace period has run out", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		travel(addDays(periodEnd, 15));
		const { headers } = await env.signInWithTestUser();
		expect(await env.api.listActiveSubscriptions({ headers })).toEqual([]);
	});
});

describe("re-check of 569026d: one subscription per identity, under concurrency", () => {
	async function secondPendingRow(
		env: TestEnv,
		base: { referenceId: string; mollieCustomerId: string },
		plan: string,
		extra = {},
	) {
		return env.context.adapter.create<any, any>({
			model: "subscription",
			data: {
				referenceId: base.referenceId,
				plan,
				status: "incomplete",
				mollieCustomerId: base.mollieCustomerId,
				customerType: "user",
				cancelAtPeriodEnd: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				...extra,
			},
		});
	}

	async function firstPayment(
		env: TestEnv,
		row: { id: string; mollieCustomerId: string },
		plan: string,
		key: string,
	) {
		const payment = await env.fake.client.payments.create({
			idempotencyKey: key,
			paymentRequest: {
				amount: { currency: "EUR", value: "9.95" },
				description: plan,
				sequenceType: "first",
				customerId: row.mollieCustomerId,
				redirectUrl: "https://app.example.com/done",
				metadata: { subscriptionId: row.id, plan, purpose: "checkout" },
			},
		} as never);
		return payment;
	}

	it("activates only one of two pending rows paid at the same time", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		const [rowA] = await env.subscriptions();
		const rowB = await secondPendingRow(env, rowA as never, "starter");
		const other = await firstPayment(env, rowB, "starter", "row-b");
		env.fake.completePayment(payment.id, "paid");
		env.fake.completePayment(other.id, "paid");

		// A's activation is in progress when B's payment arrives.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (args.model === "subscription" && args.set?.status === "active") {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		const deliveryA = env.webhook(`id=${payment.id}`);
		await paused;
		const deliveryB = env.webhook(`id=${other.id}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await deliveryA;
		await deliveryB;
		adapter.incrementOne = original;
		await env.webhook(`id=${other.id}`);

		const active = (await env.subscriptions()).filter((s) => s.status === "active");
		expect(active).toHaveLength(1);
		expect(refundedIds(env)).toHaveLength(1);
		expect(env.fake.activeSubscriptionsFor(rowA!.mollieCustomerId!)).toHaveLength(1);
	});

	it("keeps pending rows and open checkouts of another billing identity apart", async () => {
		const env = await setup();
		// An organization's pending checkout under the same reference string.
		const orgCustomer = await env.fake.client.customers.create({
			idempotencyKey: "org-customer",
			entityCustomer: { name: "Org" },
		} as never);
		const orgRow = await secondPendingRow(
			env,
			{ referenceId: env.user.id, mollieCustomerId: orgCustomer.id },
			"starter",
			{ customerType: "organization" },
		);
		const orgPayment = await firstPayment(
			env,
			{ id: orgRow.id, mollieCustomerId: orgCustomer.id },
			"starter",
			"org-payment",
		);

		const { payment } = await env.checkout("starter");
		expect(payment.id).not.toBe(orgPayment.id);
		expect(payment.customerId).not.toBe(orgCustomer.id);
		expect(await env.subscription(orgRow.id)).toMatchObject({
			customerType: "organization",
			mollieCustomerId: orgCustomer.id,
		});
	});

	it("does not refund a checkout because of a subscription whose cancellation date has passed", async () => {
		const env = await setup();
		const first = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		// A pending checkout from before; the first subscription's period has ended.
		const pending = await secondPendingRow(env, first as never, "starter");
		const payment = await firstPayment(env, pending as never, "starter", "after-cancel");
		travel(new Date(first.periodEnd!).getTime() + 3_600_000);
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);

		expect(refundedIds(env)).toEqual([]);
		expect((await env.subscription(pending.id)).status).toBe("active");
	});
});

describe("re-check of 51a5b35: restores at the deadline, legacy rows, many rows", () => {
	async function row(env: TestEnv, data: Record<string, unknown>) {
		return env.context.adapter.create<any, any>({
			model: "subscription",
			data: {
				plan: "starter",
				cancelAtPeriodEnd: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				...data,
			},
		});
	}

	async function paidCheckout(
		env: TestEnv,
		pending: { id: string; mollieCustomerId: string },
		key: string,
	) {
		const payment = await env.fake.client.payments.create({
			idempotencyKey: key,
			paymentRequest: {
				amount: { currency: "EUR", value: "9.95" },
				description: "starter",
				sequenceType: "first",
				customerId: pending.mollieCustomerId,
				redirectUrl: "https://app.example.com/done",
				metadata: { subscriptionId: pending.id, plan: "starter", purpose: "checkout" },
			},
		} as never);
		env.fake.completePayment(payment.id, "paid");
		return payment;
	}

	function pauseNext(env: TestEnv, when: (args: any) => boolean) {
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (when(args)) {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		return { paused, release, restore: () => (adapter.incrementOne = original) };
	}

	const billing = async (env: TestEnv) =>
		(await env.subscriptions()).filter(
			(s) => (s.status === "active" || s.status === "trialing") && !s.cancelAtPeriodEnd,
		);

	it("never lets a restore at the deadline and another checkout both bill", async () => {
		const env = await setup();
		const first = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		const pending = await row(env, {
			referenceId: first.referenceId,
			status: "incomplete",
			mollieCustomerId: first.mollieCustomerId,
			customerType: "user",
		});
		const payment = await paidCheckout(env, pending, "other-checkout");
		const periodEnd = new Date(first.periodEnd!).getTime();
		travel(periodEnd - 60_000);
		const { headers } = await env.signInWithTestUser();

		// The restore is decided just before the period ends, then stalls...
		const stall = pauseNext(
			env,
			(args) => args.model === "subscription" && args.set?.cancelAtPeriodEnd === false,
		);
		const restoring = env.api
			.restoreSubscription({ body: { subscriptionId: first.id }, headers })
			.catch((error: unknown) => error);
		await stall.paused;
		// ...while the period ends and the other checkout's payment arrives.
		travel(periodEnd + 60_000);
		await env.webhook(`id=${payment.id}`);
		stall.release();
		await restoring;
		stall.restore();
		await env.webhook(`id=${payment.id}`);

		expect(await billing(env)).toHaveLength(1);
		expect(env.fake.activeSubscriptionsFor(first.mollieCustomerId!).length).toBeLessThanOrEqual(1);
	});

	it("serializes a row without a customer type with typed rows of the same reference", async () => {
		const env = await setup();
		const customer = await env.fake.client.customers.create({
			idempotencyKey: "shared-customer",
			entityCustomer: { name: "Shared" },
		} as never);
		const legacy = await row(env, {
			referenceId: env.user.id,
			status: "incomplete",
			mollieCustomerId: customer.id,
		});
		const typed = await row(env, {
			referenceId: env.user.id,
			status: "incomplete",
			mollieCustomerId: customer.id,
			customerType: "organization",
		});
		const legacyPayment = await paidCheckout(env, legacy, "legacy");
		const typedPayment = await paidCheckout(env, typed, "typed");

		const stall = pauseNext(
			env,
			(args) => args.model === "subscription" && args.set?.status === "active",
		);
		const first = env.webhook(`id=${legacyPayment.id}`);
		await stall.paused;
		const second = env.webhook(`id=${typedPayment.id}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		stall.release();
		await first;
		await second;
		stall.restore();
		await env.webhook(`id=${typedPayment.id}`);

		expect(await billing(env)).toHaveLength(1);
		expect(refundedIds(env)).toHaveLength(1);
	});

	it("finds the covering subscription among many rows", async () => {
		const env = await setup();
		const past = new Date(Date.now() - 86_400_000);
		for (let i = 0; i < 21; i++) {
			await row(env, {
				referenceId: env.user.id,
				status: "active",
				cancelAtPeriodEnd: true,
				periodEnd: past,
				customerType: "user",
			});
		}
		const customer = await env.fake.client.customers.create({
			idempotencyKey: "many",
			entityCustomer: { name: "Many" },
		} as never);
		await row(env, {
			referenceId: env.user.id,
			status: "active",
			periodEnd: new Date(Date.now() + 20 * 86_400_000),
			mollieCustomerId: customer.id,
			customerType: "user",
		});
		const pending = await row(env, {
			referenceId: env.user.id,
			status: "incomplete",
			mollieCustomerId: customer.id,
			customerType: "user",
		});
		const payment = await paidCheckout(env, pending, "one-too-many");
		await env.webhook(`id=${payment.id}`);

		expect(refundedIds(env)).toEqual([payment.id]);
		expect((await env.subscription(pending.id)).status).toBe("incomplete");
	});
});

describe("re-check of 0aaf7d3: stalled restores, legacy rows both ways, paging", () => {
	async function row(env: TestEnv, data: Record<string, unknown>) {
		return env.context.adapter.create<any, any>({
			model: "subscription",
			data: {
				plan: "starter",
				cancelAtPeriodEnd: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				...data,
			},
		});
	}

	async function paidCheckout(
		env: TestEnv,
		pending: { id: string; mollieCustomerId: string },
		key: string,
	) {
		const payment = await env.fake.client.payments.create({
			idempotencyKey: key,
			paymentRequest: {
				amount: { currency: "EUR", value: "9.95" },
				description: "starter",
				sequenceType: "first",
				customerId: pending.mollieCustomerId,
				redirectUrl: "https://app.example.com/done",
				metadata: { subscriptionId: pending.id, plan: "starter", purpose: "checkout" },
			},
		} as never);
		env.fake.completePayment(payment.id, "paid");
		return payment;
	}

	function pauseNext(env: TestEnv, when: (args: any) => boolean) {
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (when(args)) {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		return { paused, release, restore: () => (adapter.incrementOne = original) };
	}

	const billing = async (env: TestEnv) =>
		(await env.subscriptions()).filter(
			(s) => (s.status === "active" || s.status === "trialing") && !s.cancelAtPeriodEnd,
		);

	it("never lets a restore that stalled past its lease undo a cancellation after another checkout took over", async () => {
		const env = await setup();
		const first = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		const pending = await row(env, {
			referenceId: first.referenceId,
			status: "incomplete",
			mollieCustomerId: first.mollieCustomerId,
			customerType: "user",
		});
		const payment = await paidCheckout(env, pending, "takeover");
		const periodEnd = new Date(first.periodEnd!).getTime();
		travel(periodEnd - 60_000);
		const { headers } = await env.signInWithTestUser();

		const stall = pauseNext(
			env,
			(args) => args.model === "subscription" && args.set?.cancelAtPeriodEnd === false,
		);
		const restoring = env.api
			.restoreSubscription({ body: { subscriptionId: first.id }, headers })
			.catch((error: unknown) => error);
		await stall.paused;
		// Well past the period end and every lease, the other checkout is paid.
		travel(periodEnd + 3 * 60_000);
		await env.webhook(`id=${payment.id}`);
		stall.release();
		await restoring;
		stall.restore();
		await env.webhook(`id=${payment.id}`);

		expect((await billing(env)).map((s) => s.id)).toEqual([pending.id]);
		expect((await env.subscription(first.id)).status).toBe("canceled");
	});

	it("serializes legacy and typed rows whichever activates first", async () => {
		const env = await setup();
		const customer = await env.fake.client.customers.create({
			idempotencyKey: "both-ways",
			entityCustomer: { name: "Both" },
		} as never);
		const typed = await row(env, {
			referenceId: env.user.id,
			status: "incomplete",
			mollieCustomerId: customer.id,
			customerType: "organization",
		});
		const legacy = await row(env, {
			referenceId: env.user.id,
			status: "incomplete",
			mollieCustomerId: customer.id,
		});
		const typedPayment = await paidCheckout(env, typed, "typed-first");
		const legacyPayment = await paidCheckout(env, legacy, "legacy-second");

		await env.webhook(`id=${typedPayment.id}`);
		await env.webhook(`id=${legacyPayment.id}`);
		expect(await billing(env)).toHaveLength(1);
		expect(refundedIds(env)).toEqual([legacyPayment.id]);
	});

	it("finds a covering subscription behind rows that end while they are read", async () => {
		const past = new Date(Date.now() - 86_400_000);
		const rows: any[] = [];
		for (let i = 0; i < 100; i++) {
			rows.push({
				id: `r${String(i).padStart(3, "0")}`,
				referenceId: "ref",
				status: "active",
				cancelAtPeriodEnd: true,
				periodEnd: past,
				lockedUntil: new Date(0),
				plan: "starter",
			});
		}
		rows.push({
			id: "z",
			referenceId: "ref",
			status: "active",
			periodEnd: new Date(Date.now() + 86_400_000),
			plan: "starter",
		});
		const matches = (r: any, where: any[]) =>
			where.every((w) => {
				const value = r[w.field];
				if (w.operator === "in") return w.value.includes(value);
				if (w.operator === "gt") return value > w.value;
				if (w.operator === "lt") return value < w.value;
				if (w.value === null) return value == null;
				return value instanceof Date
					? value.getTime() === new Date(w.value).getTime()
					: value === w.value;
			});
		const adapter = {
			findMany: async ({ where, limit, offset = 0 }: any) =>
				rows
					.filter((r) => matches(r, where))
					.sort((a, b) => (a.id < b.id ? -1 : 1))
					.slice(offset, offset + limit),
			findOne: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
			incrementOne: async ({ where, set }: any) => {
				const target = rows.find((r) => matches(r, where));
				if (!target) return null;
				Object.assign(target, set);
				return target;
			},
		};
		const { coverage } = await import("../../src/billing");
		const result = await coverage(
			{ context: { adapter, runInBackground: () => {}, logger: console } } as never,
			{ subscription: { enabled: true, plans: PLANS } } as never,
			{ referenceId: "ref", customerType: null },
			"new",
			new Date(),
		);
		expect(result).toBe("covered");
		expect(rows.filter((r) => r.status === "canceled")).toHaveLength(100);
	});
});

describe("re-check of 18c1571: activations that stall past their leases", () => {
	it("never lets a stalled activation complete after another pending row activated", async () => {
		const env = await setup();
		const customer = await env.fake.client.customers.create({
			idempotencyKey: "stalled-activation",
			entityCustomer: { name: "Stalled" },
		} as never);
		const pending = async (key: string) => {
			const row = await env.context.adapter.create<any, any>({
				model: "subscription",
				data: {
					referenceId: env.user.id,
					plan: "starter",
					status: "incomplete",
					mollieCustomerId: customer.id,
					customerType: "user",
					cancelAtPeriodEnd: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			const payment = await env.fake.client.payments.create({
				idempotencyKey: key,
				paymentRequest: {
					amount: { currency: "EUR", value: "9.95" },
					description: "starter",
					sequenceType: "first",
					customerId: customer.id,
					redirectUrl: "https://app.example.com/done",
					metadata: { subscriptionId: row.id, plan: "starter", purpose: "checkout" },
				},
			} as never);
			env.fake.completePayment(payment.id, "paid");
			return { row, payment };
		};
		const a = await pending("a");
		const b = await pending("b");

		// A's activation is decided, then stalls past every lease.
		const adapter = env.context.adapter as any;
		const original = adapter.incrementOne.bind(adapter);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		adapter.incrementOne = async (args: any) => {
			if (args.model === "subscription" && args.set?.status === "active") {
				adapter.incrementOne = original;
				reached();
				await gate;
			}
			return original(args);
		};
		const deliveryA = env.webhook(`id=${a.payment.id}`);
		await paused;
		travel(Date.now() + 3 * 60_000);
		await env.webhook(`id=${b.payment.id}`);
		release();
		await deliveryA;
		adapter.incrementOne = original;
		await env.webhook(`id=${a.payment.id}`);

		const billing = (await env.subscriptions()).filter((s) => s.status === "active");
		expect(billing.map((s) => s.id)).toEqual([b.row.id]);
		expect(refundedIds(env)).toEqual([a.payment.id]);
	});
});

describe("re-check of a354581: hooks when an activation has to come back", () => {
	it("runs the paid hook once when the activation is retried after a busy pending row", async () => {
		const onPaymentPaid = vi.fn(async (_data: any) => {});
		const env = await setup({ subscription: { onPaymentPaid } });
		const { payment } = await env.checkout("starter");
		const [rowA] = await env.subscriptions();
		// Another pending row of the same customer is being processed right now.
		const rowB = await env.context.adapter.create<any, any>({
			model: "subscription",
			data: {
				referenceId: rowA!.referenceId,
				plan: "starter",
				status: "incomplete",
				mollieCustomerId: rowA!.mollieCustomerId,
				customerType: "user",
				cancelAtPeriodEnd: false,
				lockToken: "someone-else",
				lockedUntil: new Date(Date.now() + 60_000),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		env.fake.completePayment(payment.id, "paid");
		expect((await env.webhook(`id=${payment.id}`)).status).toBe(409);

		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: rowB.id }],
			update: { lockedUntil: new Date(0) },
		});
		expect((await env.webhook(`id=${payment.id}`)).status).toBe(200);
		await settle();
		expect((await env.subscription(rowA!.id)).status).toBe("active");
		expect(onPaymentPaid.mock.calls.map(([data]) => data.payment.id)).toEqual([payment.id]);
	});
});
