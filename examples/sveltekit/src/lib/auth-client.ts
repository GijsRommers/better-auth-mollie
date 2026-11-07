import { createAuthClient } from "better-auth/svelte";
import { mollieClient } from "better-auth-mollie/client";

export const authClient = createAuthClient({
	plugins: [mollieClient({ subscription: true })],
});
