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
		expect(response.status).toBeGreaterThanOrEqual(500);
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
