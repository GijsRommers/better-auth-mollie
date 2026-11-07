import { plans } from "$lib/plans";
import { auth } from "$lib/server/auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, request }) => {
	if (!locals.user) return { user: null, plans, subscriptions: [] };
	// Applies clock-based changes (period ended, scheduled plan change) too.
	const subscriptions = await auth.api.listActiveSubscriptions({ headers: request.headers });
	return { user: locals.user, plans, subscriptions };
};
