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

async function chooseFinalState(page: Page, state: FinalState) {
	await page.waitForURL(/\/checkout\/test-mode/, { timeout: 60_000 });
	await page.locator(`input[name="final_state"][value="${state}"]`).check();
	await Promise.all([
		page
			.waitForURL((u) => !u.pathname.startsWith("/checkout/test-mode"), { timeout: 60_000 })
			.catch(() => {}),
		page.locator('button[name="submit"]').click(),
	]);
}

/** Completes a checkout URL (first payment) with the given final state. */
export async function completeCheckout(url: string, state: FinalState): Promise<void> {
	const page = await open(url);
	try {
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
export async function changePaymentState(url: string, state: FinalState): Promise<void> {
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
