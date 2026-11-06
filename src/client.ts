import type { BetterAuthClientPlugin } from "better-auth/client";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import type { mollie } from "./index";
import type { MolliePlan } from "./types";
import { PACKAGE_VERSION } from "./version";

/**
 * Client plugin: adds `authClient.subscription.upgrade`, `cancel`, `restore`
 * and `list`, with types inferred from the server plugin.
 *
 * ```ts
 * import { createAuthClient } from "better-auth/client";
 * import { mollieClient } from "better-auth-mollie/client";
 *
 * export const authClient = createAuthClient({
 *   plugins: [mollieClient({ subscription: true })],
 * });
 * ```
 */
export const mollieClient = <O extends { subscription: boolean }>(_options?: O) => {
	return {
		id: "mollie-client",
		version: PACKAGE_VERSION,
		$InferServerPlugin: {} as ReturnType<
			typeof mollie<
				O["subscription"] extends true
					? { mollieClient: any; subscription: { enabled: true; plans: MolliePlan[] } }
					: { mollieClient: any }
			>
		>,
		pathMethods: {
			"/subscription/restore": "POST",
			"/subscription/cancel": "POST",
		},
		$ERROR_CODES: MOLLIE_ERROR_CODES,
	} satisfies BetterAuthClientPlugin;
};

export { MOLLIE_ERROR_CODES } from "./error-codes";
export type * from "./types";
