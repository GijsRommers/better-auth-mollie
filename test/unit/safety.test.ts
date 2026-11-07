import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { AUTH_URL, gate, settle, setup, subscribe, type TestEnv, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

describe("prices cannot be changed from the outside", () => {
	it("ignores reserved keys in caller metadata", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter", {
			metadata: {
				grossAmount: "1.00",
				netAmount: "1.00",
				vatAmount: "0.00",
				vatRate: "0.00",
				purpose: "recovery",
				plan: "business",
				trial: true,
				trialDays: 365,
				note: "kept",
			},
		});
		expect(payment.metadata).toMatchObject({ plan: "starter", purpose: "checkout", trial: false });
		expect(payment.metadata).not.toHaveProperty("grossAmount");
		expect(payment.metadata).toHaveProperty("note", "kept");

		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [mollieSubscription] = [...env.fake.subscriptions.values()];
		expect(mollieSubscription?.amount.value).toBe("9.95");
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});
});

describe("renewals only pay for their own period", () => {
	it("does not let an old paid renewal reactivate a past-due subscription", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const mollieId = subscription.mollieSubscriptionId!;
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const january = env.fake.chargeSubscription(mollieId, "paid");
		await env.webhook(`id=${january.id}`);
		const renewed = await env.subscription(subscription.id);

		travel(new Date(renewed.periodEnd!).getTime() + 3_600_000);
		const february = env.fake.chargeSubscription(mollieId, "failed");
		await env.webhook(`id=${february.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		// January's payment is delivered again, and the cron re-reads it too.
		await env.webhook(`id=${january.id}`);
		await syncMollieSubscriptions(env.auth as never);
		const after = await env.subscription(subscription.id);
		expect(after.status).toBe("past_due");
		expect(after.periodEnd).toEqual(renewed.periodEnd);
	});
});

describe("concurrent changes leave exactly one chargeable Mollie subscription", () => {
	/** Pauses the next create of `method` after Mollie stored it, until released. */
	function pauseAfterCreate(env: TestEnv, method: string) {
		const { paused, release, hold } = gate();
		env.fake.afterNextCreate(method, hold);
		return { paused, release };
	}

	it("serializes plan changes: a racing change neither adds a subscription nor a charge", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		// A has canceled the old Mollie subscription and created its replacement,
		// but has not recorded it yet.
		const pause = pauseAfterCreate(env, "subscriptions.create");
		const a = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await pause.paused;
		// B changes to another plan meanwhile.
		const b = await env.api
			.upgradeSubscription({ body: { plan: "yearly" }, headers: env.headers })
			.catch((error: unknown) => error);
		pause.release();
		await a;

		expect(b).toMatchObject({ body: { code: "OPERATION_IN_PROGRESS" } });
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		const row = await env.subscription(subscription.id);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		const prorations = [...env.fake.payments.values()].filter(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		);
		expect(prorations).toHaveLength(1);
	});

	it("keeps the restored subscription when restores race", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/" }, headers: env.headers });
		// A created the new Mollie subscription but has not recorded it yet.
		const pause = pauseAfterCreate(env, "subscriptions.create");
		const a = env.api
			.restoreSubscription({ body: {}, headers: env.headers })
			.catch((e: unknown) => e);
		await pause.paused;
		const b = await env.api
			.restoreSubscription({ body: {}, headers: env.headers })
			.catch((e: unknown) => e);
		pause.release();
		await a;

		expect(b).toMatchObject({ body: { code: "OPERATION_IN_PROGRESS" } });
		const row = await env.subscription(subscription.id);
		expect(row.cancelAtPeriodEnd).toBe(false);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
	});

	it("cancels the Mollie subscription of a first payment that lost the activation race", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await Promise.all([
			env.webhook(`id=${first.payment.id}`),
			env.webhook(`id=${second.payment.id}`),
		]);
		const [row] = await env.subscriptions();
		expect(row?.status).toBe("active");
		const active = env.fake.activeSubscriptionsFor(row!.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row!.mollieSubscriptionId]);
	});

	it("sweeps an orphaned Mollie subscription before it can charge", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		// A replacement created by a change that crashed before recording it.
		const orphan = await env.fake.client.subscriptions.create({
			customerId: subscription.mollieCustomerId!,
			idempotencyKey: "lost",
			subscriptionRequest: {
				amount: { currency: "EUR", value: "49.00" },
				interval: "1 month",
				description: "orphan",
				metadata: { subscriptionId: subscription.id },
			},
		} as never);
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.subscriptions.get(orphan.id)?.status).toBe("canceled");
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");
	});
});

describe("checkouts", () => {
	it("starts a new subscription row when the old checkout expired in the meantime", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		env.fake.completePayment(first.payment.id, "failed"); // webhook not delivered yet
		const second = await env.checkout("starter");
		expect(second.payment.id).not.toBe(first.payment.id);

		const rows = await env.subscriptions();
		expect(rows.map((r) => r.status)).toEqual(["incomplete_expired", "incomplete"]);
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${second.payment.id}`);
		expect((await env.subscriptions())[1]?.status).toBe("active");
	});

	it("expires a failed checkout even if the process stopped right after recording it", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "failed");
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: payment.id }],
			update: { status: "failed" },
		});
		await env.webhook(`id=${payment.id}`);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete_expired");
	});

	it("does not let another user sync someone else's checkout from the redirect URL", async () => {
		const env = await setup();
		env.authorizeReference.mockResolvedValue(false);
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.auth.api.signUpEmail({
			body: { email: "other@test.com", password: "password1234", name: "Other" },
		});
		const other = await env.signInWithUser("other@test.com", "password1234");
		const response = await env.auth.handler(
			new Request(payment.redirectUrl!, { headers: other.headers }),
		);
		expect(response.status).toBe(302);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete");
		// The owner's own redirect does sync it.
		await env.auth.handler(new Request(payment.redirectUrl!, { headers: env.headers }));
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});

	it("points the redirect at the plugin's success endpoint", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		expect(payment.redirectUrl?.startsWith(`${AUTH_URL}/subscription/success?`)).toBe(true);
	});
});

describe("customer details", () => {
	it("keeps the Mollie customer in sync with the user's latest name and email", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		await env.api.updateUser({ body: { name: "Renamed User" }, headers: env.headers });
		await settle();
		expect(env.fake.customers.get(payment.customerId!)?.name).toBe("Renamed User");
	});
});

describe("interrupted and racing billing flows", () => {
	/** past_due after a failed renewal; returns fresh sign-in headers (sessions expire). */
	async function delinquent(env: TestEnv) {
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		const { headers } = await env.signInWithTestUser();
		return { subscription, headers };
	}

	async function recover(env: TestEnv, headers: Headers) {
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
		return [...env.fake.payments.values()].at(-1)!;
	}

	it("never re-applies an old recovery payment to a later delinquency", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recover(env, headers);
		env.fake.completePayment(recovery.id, "paid");
		await env.webhook(`id=${recovery.id}`);
		const recovered = await env.subscription(subscription.id);
		expect(recovered.status).toBe("active");

		travel(new Date(recovered.periodEnd!).getTime() + 3_600_000);
		const failedAgain = env.fake.chargeSubscription(recovered.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failedAgain.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		const remotesBefore = env.fake.subscriptions.size;
		await env.webhook(`id=${recovery.id}`);
		const after = await env.subscription(subscription.id);
		expect(after.status).toBe("past_due");
		expect(after.periodEnd).toEqual(recovered.periodEnd);
		expect(env.fake.subscriptions.size).toBe(remotesBefore);
	});

	it("refuses a recovery checkout while Mollie is still retrying the charge", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers }),
		).rejects.toMatchObject({ body: { code: "PAYMENT_IN_PROGRESS" } });
	});

	it("refunds a recovery payment when Mollie's own retry already paid", async () => {
		const onDuplicatePayment = vi.fn(async () => {});
		const env = await setup({ subscription: { onDuplicatePayment } });
		const { subscription, headers } = await delinquent(env);
		const recovery = await recover(env, headers);
		const retry = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${retry.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");

		env.fake.completePayment(recovery.id, "paid");
		await env.webhook(`id=${recovery.id}`);
		await env.webhook(`id=${recovery.id}`);
		expect([...env.fake.refunds.values()].map((r) => r.paymentId)).toEqual([recovery.id]);
		await settle();
		expect(onDuplicatePayment).toHaveBeenCalledTimes(1);
		expect(onDuplicatePayment.mock.calls[0]).toMatchObject([
			{ refunded: true, purpose: "recovery" },
			expect.anything(),
		]);
	});

	it("refunds the second of two paid checkouts", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		await env.webhook(`id=${second.payment.id}`);
		expect([...env.fake.refunds.values()].map((r) => r.paymentId)).toEqual([second.payment.id]);
		expect((await env.subscriptions())[0]).toMatchObject({ status: "active", plan: "starter" });
	});

	it("describes a duplicate's refund with refundDescription", async () => {
		const refundDescription = vi.fn(
			({ reason }: { reason: string }) => `Terugbetaling (${reason})`,
		);
		const env = await setup({ subscription: { refundDescription } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		await env.webhook(`id=${second.payment.id}`);
		expect([...env.fake.refunds.values()]).toEqual([
			expect.objectContaining({
				paymentId: second.payment.id,
				description: "Terugbetaling (duplicate)",
			}),
		]);
		expect(refundDescription.mock.calls[0]![0]).toMatchObject({
			reason: "duplicate",
			payment: { id: second.payment.id },
		});
	});

	it("finishes a plan change whose Mollie response was lost, without a second subscription", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const row = await env.subscription(subscription.id);
		expect(row.pendingPlan).toBe("starter");
		// The replacement exists at Mollie but was never recorded.
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toHaveLength(1);
		expect(env.fake.subscriptions.get(row.mollieSubscriptionId!)?.status).toBe("canceled");

		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const healed = await env.subscription(subscription.id);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([healed.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({ amount: { value: "9.95" }, metadata: { plan: "starter" } });
	});

	it("moves billing to the upgraded plan even if canceling the old Mollie subscription failed", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		expect((await env.subscription(subscription.id)).plan).toBe("business");
		// Still billing the old plan for now...
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)[0]?.amount.value).toBe(
			"9.95",
		);

		// ...until the sync before the next payment date fixes it.
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]?.amount.value).toBe("49.00");
	});

	it("finishes a paid recovery that was never applied", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recover(env, headers);
		env.fake.completePayment(recovery.id, "paid");
		// The payment was recorded as paid, then the process stopped.
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: recovery.id }],
			update: { status: "paid", paidAt: new Date() },
		});
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("notices a failed pro-rata charge whose webhook never arrived", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const proration = [...env.fake.payments.values()].at(-1)!;
		expect((proration.metadata as { purpose: string }).purpose).toBe("proration");
		env.fake.completePayment(proration.id, "failed");
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
	});
});

describe("re-check findings", () => {
	it("never stretches a late renewal's coverage when it is processed again", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const mollieId = subscription.mollieSubscriptionId!;
		// Mollie's charge for cycle 1 only succeeds two days late (a retry).
		travel(new Date(subscription.periodEnd!).getTime() + 2 * 86_400_000);
		const late = env.fake.chargeSubscription(mollieId, "paid");
		await env.webhook(`id=${late.id}`);
		const covered = await env.subscription(subscription.id);
		expect(covered.periodStart).toEqual(subscription.periodEnd);

		travel(new Date(covered.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(mollieId, "failed");
		await env.webhook(`id=${failed.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		await env.webhook(`id=${late.id}`);
		await syncMollieSubscriptions(env.auth as never);
		const after = await env.subscription(subscription.id);
		expect(after.status).toBe("past_due");
		expect(after.periodEnd).toEqual(covered.periodEnd);
	});

	it("stops a lock holder that stalled past its lease from charging", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const stalled = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let stall = false;
		const env = await setup({
			subscription: {
				tax: {
					calculate: async () => {
						if (stall) {
							stall = false;
							reached();
							await gate;
						}
						return { rate: "21.00" };
					},
				},
			},
		});
		const subscription = await subscribe(env, "starter");
		stall = true;
		const a = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await stalled;
		// A is stuck in the tax callback for longer than the lease...
		travel(Date.now() + 3 * 60_000);
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "yearly" }, headers });
		// ...and must not charge when it wakes up.
		release();
		expect(await a).toMatchObject({ body: { code: "OPERATION_IN_PROGRESS" } });
		const prorations = [...env.fake.payments.values()].filter(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		);
		expect(prorations).toHaveLength(0);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ plan: "starter", pendingPlan: "yearly" });
	});

	it("does not adopt a reused Mollie subscription that was canceled in the meantime", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		const scheduled = await env.subscription(subscription.id);
		// Simulate a crash before adoption, after which the sweep canceled it.
		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: subscription.id }],
			update: { mollieSubscriptionId: subscription.mollieSubscriptionId },
		});
		env.fake.setSubscriptionStatus(scheduled.mollieSubscriptionId!, "canceled");

		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const healed = await env.subscription(subscription.id);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([healed.mollieSubscriptionId]);
		expect(healed.mollieSubscriptionId).not.toBe(scheduled.mollieSubscriptionId);
		expect(active[0]?.metadata).toMatchObject({ plan: "starter" });
	});

	it("refunds and stops an orphaned Mollie subscription at its first charge", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const orphan = await env.fake.client.subscriptions.create({
			customerId: subscription.mollieCustomerId!,
			idempotencyKey: "lost",
			subscriptionRequest: {
				amount: { currency: "EUR", value: "9.95" },
				interval: "1 month",
				description: "orphan",
				metadata: { subscriptionId: subscription.id, plan: "starter" },
			},
		} as never);
		const charge = env.fake.chargeSubscription(orphan.id, "paid");
		await env.webhook(`id=${charge.id}`);
		expect([...env.fake.refunds.values()].map((r) => r.paymentId)).toEqual([charge.id]);
		expect(env.fake.subscriptions.get(orphan.id)?.status).toBe("canceled");
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");
	});
});
