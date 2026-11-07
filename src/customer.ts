import type { GenericEndpointContext, User } from "better-auth";
import { APIError } from "better-auth/api";
import type { Organization } from "better-auth/plugins/organization";
import type { CustomerResponse } from "mollie-api-typescript/models";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import { toAPIError } from "./errors";
import { gatewayFor } from "./gateway";
import { runOperation } from "./operations";
import type { CustomerType, MollieOptions, WithMollieCustomerId } from "./types";
import { mergeMetadata } from "./utils";

/**
 * Returns the Mollie customer id for a billing reference, creating the
 * customer (through the operation journal) when it does not exist yet.
 */
export async function getOrCreateCustomer(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	reference: { customerType: CustomerType; referenceId: string },
): Promise<string> {
	const { adapter } = ctx.context;
	const { customerType, referenceId } = reference;

	let name: string | undefined;
	let email: string | undefined;
	let extra: Record<string, any> = {};
	let user: (User & WithMollieCustomerId) | null = null;
	let organization: (Organization & WithMollieCustomerId) | null = null;

	if (customerType === "organization") {
		organization = await adapter.findOne<Organization & WithMollieCustomerId>({
			model: "organization",
			where: [{ field: "id", value: referenceId }],
		});
		if (!organization)
			throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ORGANIZATION_NOT_FOUND);
		if (organization.mollieCustomerId) return organization.mollieCustomerId;
		name = organization.name;
		extra = (await options.organization?.getCustomerCreateParams?.(organization, ctx)) ?? {};
	} else {
		user = await adapter.findOne<User & WithMollieCustomerId>({
			model: "user",
			where: [{ field: "id", value: referenceId }],
		});
		if (!user) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.CUSTOMER_NOT_FOUND);
		if (user.mollieCustomerId) return user.mollieCustomerId;
		name = user.name;
		email = user.email;
		extra = (await options.getCustomerCreateParams?.(user, ctx)) ?? {};
	}

	const gateway = gatewayFor(options);
	let mollieCustomerId: string;
	try {
		const operation = await runOperation(ctx.context, {
			kind: "create_customer",
			referenceId,
			scope: `customer:${customerType}:${referenceId}`,
			reuseSucceeded: true,
			execute: (idempotencyKey) =>
				gateway.createCustomer(
					{
						...extra,
						name: extra.name ?? name,
						email: extra.email ?? email,
						metadata: mergeMetadata(
							{
								customerType,
								...(customerType === "organization"
									? { organizationId: referenceId }
									: { userId: referenceId }),
								operationKey: idempotencyKey,
							},
							extra.metadata,
						),
					},
					idempotencyKey,
				),
			getId: (customer) => customer.id,
			recover: (idempotencyKey, attempt) =>
				gateway.findCustomerByOperationKey(idempotencyKey, attempt.createdAt),
		});
		mollieCustomerId = operation.mollieId;
	} catch (error) {
		ctx.context.logger.error("[mollie] Unable to create customer", error);
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_CUSTOMER);
	}

	await adapter.update({
		model: customerType,
		where: [{ field: "id", value: referenceId }],
		update: { mollieCustomerId },
	});

	const hook = organization ? options.organization?.onCustomerCreate : options.onCustomerCreate;
	if (
		hook &&
		(await claimDelivery(
			ctx,
			`hook:customer-created:${customerType}:${referenceId}`,
			referenceId,
			mollieCustomerId,
		))
	) {
		const created: CustomerResponse = await gateway.getCustomer(mollieCustomerId);
		if (organization) {
			await options.organization?.onCustomerCreate?.(
				{ mollieCustomer: created, organization: { ...organization, mollieCustomerId } },
				ctx,
			);
		} else if (user) {
			await options.onCustomerCreate?.(
				{ mollieCustomer: created, user: { ...user, mollieCustomerId } },
				ctx,
			);
		}
	}
	return mollieCustomerId;
}

/**
 * Claims a one-time delivery (e.g. of a hook) by inserting a journal row
 * with a unique key. Exactly one concurrent caller gets `true`.
 */
export async function claimDelivery(
	ctx: GenericEndpointContext,
	key: string,
	referenceId: string,
	mollieId: string,
): Promise<boolean> {
	try {
		await ctx.context.adapter.create({
			model: "mollieOperation",
			data: {
				idempotencyKey: key,
				kind: "hook_delivery",
				referenceId,
				status: "succeeded",
				mollieId,
				createdAt: new Date(),
			},
		});
		return true;
	} catch (error) {
		const existing = await ctx.context.adapter.findOne({
			model: "mollieOperation",
			where: [{ field: "idempotencyKey", value: key }],
		});
		if (existing) return false;
		throw error;
	}
}

/**
 * Brings the Mollie customer's name (and, for users, email) in line with the
 * current database row. Reads the latest row and only writes when Mollie
 * differs, so overlapping runs converge on the newest values.
 */
export async function syncCustomerDetails(
	context: GenericEndpointContext["context"],
	options: MollieOptions,
	customerType: CustomerType,
	referenceId: string,
): Promise<void> {
	const row = await context.adapter.findOne<
		{ name: string; email?: string | null } & WithMollieCustomerId
	>({ model: customerType, where: [{ field: "id", value: referenceId }] });
	if (!row?.mollieCustomerId) return;
	const desired: { name: string; email?: string } = { name: row.name };
	if (customerType === "user" && row.email) desired.email = row.email;
	const gateway = gatewayFor(options);
	const remote = await gateway.getCustomer(row.mollieCustomerId);
	const same =
		remote.name === desired.name && (desired.email === undefined || remote.email === desired.email);
	if (!same) await gateway.updateCustomer(row.mollieCustomerId, desired);
}
