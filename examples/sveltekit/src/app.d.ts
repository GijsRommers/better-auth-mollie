import type { auth } from "$lib/server/auth";

type Session = typeof auth.$Infer.Session;

declare global {
	namespace App {
		interface Locals {
			user: Session["user"] | null;
			session: Session["session"] | null;
		}
	}
}
