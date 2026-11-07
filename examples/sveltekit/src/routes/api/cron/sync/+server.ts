import { error, json } from "@sveltejs/kit";
import { syncMollieSubscriptions } from "better-auth-mollie";
import { env } from "$env/dynamic/private";
import { auth } from "$lib/server/auth";
import type { RequestHandler } from "./$types";

/**
 * Call hourly from your scheduler:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://example.com/api/cron/sync
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
		error(401, "Unauthorized");
	}
	return json(await syncMollieSubscriptions(auth));
};
