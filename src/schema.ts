import type { BetterAuthPluginDBSchema } from "better-auth";
import { mergeSchema } from "better-auth/db";
import type { MollieOptions } from "./types";

export const subscriptions = {
	subscription: {
		fields: {
			referenceId: {
				type: "string",
				required: true,
				input: false,
				index: true,
			},
			plan: {
				type: "string",
				required: true,
			},
			status: {
				type: "string",
				required: true,
				defaultValue: "incomplete",
				input: false,
				index: true,
			},
			mollieCustomerId: {
				type: "string",
				required: false,
				input: false,
			},
			mollieMandateId: {
				type: "string",
				required: false,
				input: false,
			},
			mollieSubscriptionId: {
				type: "string",
				required: false,
				input: false,
				index: true,
			},
			periodStart: {
				type: "date",
				required: false,
			},
			periodEnd: {
				type: "date",
				required: false,
			},
			trialEnd: {
				type: "date",
				required: false,
			},
			cancelAtPeriodEnd: {
				type: "boolean",
				required: false,
				defaultValue: false,
			},
			createdAt: {
				type: "date",
				required: true,
				input: false,
				defaultValue: () => new Date(),
			},
			updatedAt: {
				type: "date",
				required: true,
				input: false,
				defaultValue: () => new Date(),
				onUpdate: () => new Date(),
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const molliePayments = {
	molliePayment: {
		fields: {
			molliePaymentId: {
				type: "string",
				required: true,
				unique: true,
				input: false,
			},
			subscriptionId: {
				type: "string",
				required: true,
				input: false,
				index: true,
				references: {
					model: "subscription",
					field: "id",
					onDelete: "cascade",
				},
			},
			amount: {
				type: "string",
				required: true,
			},
			currency: {
				type: "string",
				required: true,
			},
			status: {
				type: "string",
				required: true,
			},
			sequenceType: {
				type: "string",
				required: true,
			},
			paidAt: {
				type: "date",
				required: false,
			},
			failedAt: {
				type: "date",
				required: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const mollieOperations = {
	mollieOperation: {
		fields: {
			idempotencyKey: {
				type: "string",
				required: true,
				unique: true,
				input: false,
			},
			kind: {
				type: "string",
				required: true,
			},
			referenceId: {
				type: "string",
				required: true,
				index: true,
			},
			status: {
				type: "string",
				required: true,
			},
			mollieId: {
				type: "string",
				required: false,
			},
			createdAt: {
				type: "date",
				required: true,
				input: false,
				defaultValue: () => new Date(),
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const user = {
	user: {
		fields: {
			mollieCustomerId: {
				type: "string",
				required: false,
				input: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const organization = {
	organization: {
		fields: {
			mollieCustomerId: {
				type: "string",
				required: false,
				input: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

/** The full schema, used to type the `schema` customization option. */
export const getSchemaDefinition = () => ({
	...subscriptions,
	...molliePayments,
	...mollieOperations,
	...user,
	...organization,
});

export function isOrganizationBillingEnabled(options: MollieOptions): boolean {
	if (options.organization?.enabled !== undefined) return options.organization.enabled;
	if (!options.subscription?.enabled) return !!options.organization;
	return (options.subscription.customerType ?? "organization") === "organization";
}

export function getSchema(options: MollieOptions) {
	const base: BetterAuthPluginDBSchema = {
		...user,
		...(options.subscription?.enabled
			? { ...subscriptions, ...molliePayments, ...mollieOperations }
			: { ...mollieOperations }),
		...(isOrganizationBillingEnabled(options) ? organization : {}),
	};
	return mergeSchema(base, options.schema as never);
}
