import { type Browser, chromium, type Page } from "playwright";

/**
 * Drives Mollie's hosted test-mode pages with a headless browser:
 *
 * - card checkout: fills Mollie Components (inside an iframe) with a test
 *   card, then continues to the test-mode status page;
 * - the test-mode status page (also what `_links.changePaymentState` opens
 *   for recurring test payments): picks the final state and submits.
 *
 * Selectors are language-independent (the page may render in Dutch).
 */
export type FinalState = "paid" | "failed" | "expired" | "canceled" | "open";
/** What the test-mode page offers for a payment that is paid already. */
export type PaidState = "chargeback";

const TEST_CARD = {
	number: "4543474002249996",
	expiry: "12/30",
	cvc: "123",
	holder: "Test Holder",
};

let browser: Browser | undefined;

async function open(url: string): Promise<Page> {
	browser ??= await chromium.launch();
	const page = await browser.newPage({ locale: "en-US" });
	await page.goto(url, { waitUntil: "networkidle" });
	return page;
}

async function chooseFinalState(page: Page, state: FinalState | PaidState) {
	await page.waitForURL(/\/checkout\/test-mode/, { timeout: 60_000 });

	// A paid payment offers actions instead of states.
	const choice =
		state === "chargeback"
			? 'input[name="action"][value="create-chargeback"]'
			: `input[name="final_state"][value="${state}"]`;
	await page.locator(choice).check();
	// Submitting sets the state; the page then reloads (or redirects, for a
	// payment with a redirect URL).
	await Promise.all([
		page.waitForEvent("framenavigated", {
			predicate: (frame) => frame === page.mainFrame(),
			timeout: 60_000,
		}),
		page.locator('button[name="submit"]').click(),
	]);
}

/**
 * Completes a checkout URL (first payment) with the given final state. When
 * the payment has no fixed method, `method` is picked on Mollie's method
 * selection page.
 */
export async function completeCheckout(
	url: string,
	state: FinalState,
	method = "creditcard",
): Promise<void> {
	const page = await open(url);
	try {
		if (page.url().includes("/select-method/")) {
			await Promise.all([
				page.waitForURL((u) => !u.pathname.includes("/select-method/"), { timeout: 60_000 }),
				page.locator(`button[name="method"][value="${method}"]`).click(),
			]);
			await page.waitForLoadState("networkidle");
		}
		if (page.url().includes("/select-issuer/")) {
			// iDEAL and similar: any test bank leads to the test-mode page.
			await Promise.all([
				page.waitForURL((u) => !u.pathname.includes("/select-issuer/"), { timeout: 60_000 }),
				page.locator('button[name="issuer"]').first().click(),
			]);
		}
		if (page.url().includes("/credit-card/")) {
			const card = page.frameLocator('iframe[src*="components/card"]');
			await card.locator("#cardNumber").fill(TEST_CARD.number);
			await card.locator("#cardExpiryDate").fill(TEST_CARD.expiry);
			await card.locator("#cardCvv").fill(TEST_CARD.cvc);
			await card.locator("#cardHolder").fill(TEST_CARD.holder);
			await card.locator("button[type=submit]").click();
		}
		await chooseFinalState(page, state);
	} finally {
		await page.close();
	}
}

/** Opens a `changePaymentState` link and sets the payment's final state. */
export async function changePaymentState(
	url: string,
	state: FinalState | PaidState,
): Promise<void> {
	const page = await open(url);
	try {
		await chooseFinalState(page, state);
	} finally {
		await page.close();
	}
}

export async function closeBrowser(): Promise<void> {
	await browser?.close();
	browser = undefined;
}
