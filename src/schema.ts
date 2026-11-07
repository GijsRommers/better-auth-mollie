import type { BetterAuthPluginDBSchema } from "better-auth";
import { mergeSchema } from "better-auth/db";
import type { MollieOptions } from "./types";

export const subscriptionSchema = {
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
			pendingPlan: {
				type: "string",
				required: false,
				input: false,
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
			customerType: {
				type: "string",
				required: false,
				input: false,
			},
			appliedPaymentId: {
				type: "string",
				required: false,
				input: false,
			},
			mollieSyncNeeded: {
				type: "boolean",
				required: false,
				defaultValue: false,
				input: false,
			},
			mollieSyncRevision: {
				type: "number",
				required: false,
				defaultValue: 0,
				input: false,
			},
			lockToken: {
				type: "string",
				required: false,
				input: false,
			},
			lockedUntil: {
				type: "date",
				required: false,
				defaultValue: () => new Date(0),
				input: false,
			},
			lockSerial: {
				type: "number",
				required: false,
				defaultValue: 0,
				input: false,
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

export const molliePaymentSchema = {
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
			outcome: {
				type: "string",
				required: true,
				defaultValue: "pending",
				input: false,
			},
			claimSerial: {
				type: "number",
				required: false,
				defaultValue: 0,
				input: false,
			},
			hooksDue: {
				type: "boolean",
				required: false,
				defaultValue: false,
				input: false,
			},
			invoice: {
				type: "string",
				required: false,
				input: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const mollieOperationSchema = {
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

export const userSchema = {
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

export const organizationSchema = {
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
	...subscriptionSchema,
	...molliePaymentSchema,
	...mollieOperationSchema,
	...userSchema,
	...organizationSchema,
});

export function isOrganizationBillingEnabled(options: MollieOptions): boolean {
	if (options.organization?.enabled !== undefined) return options.organization.enabled;
	if (!options.subscription?.enabled) return !!options.organization;
	return (options.subscription.customerType ?? "organization") === "organization";
}

export function getSchema(options: MollieOptions) {
	const base: BetterAuthPluginDBSchema = {
		...userSchema,
		...(options.subscription?.enabled
			? { ...subscriptionSchema, ...molliePaymentSchema, ...mollieOperationSchema }
			: { ...mollieOperationSchema }),
		...(isOrganizationBillingEnabled(options) ? organizationSchema : {}),
	};
	return mergeSchema(base, options.schema as never);
}
