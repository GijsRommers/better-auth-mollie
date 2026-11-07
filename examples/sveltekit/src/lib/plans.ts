import type { MolliePlan } from "better-auth-mollie";

/** Net prices; VAT is added per customer (see `tax` in auth.ts). */
export const plans: MolliePlan[] = [
	{
		name: "starter",
		amount: "9.00",
		interval: "1 month",
		description: "Starter plan",
		limits: { projects: 3 },
	},
	{
		name: "pro",
		amount: "29.00",
		interval: "1 month",
		description: "Pro plan",
		limits: { projects: 50 },
		freeTrial: { days: 14 },
	},
	{
		name: "pro-yearly",
		amount: "290.00",
		interval: "12 months",
		description: "Pro plan, yearly",
		limits: { projects: 50 },
	},
];
