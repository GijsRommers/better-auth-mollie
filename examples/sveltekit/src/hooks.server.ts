import type { Handle, ServerInit } from "@sveltejs/kit";
import { getMigrations } from "better-auth/db/migration";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";
import { auth } from "$lib/server/auth";

export const init: ServerInit = async () => {
	// Creates or updates the tables, including the plugin's, in the SQLite
	// file. In production, run `npx @better-auth/cli migrate` instead.
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
};

export const handle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user ?? null;
	event.locals.session = session?.session ?? null;
	return svelteKitHandler({ event, resolve, auth, building });
};
