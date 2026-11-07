/**
 * The plans configuration does not allow billing something new: Mollie
 * keeps billing as it was, and the sync reports it (without holding up
 * decisions that do not need plans).
 */
export class PlanConfigurationError extends Error {}

/**
 * A subscription's plan (or the plan it is scheduled to change to) is not in
 * the configuration.
 */
export class PlanNotConfiguredError extends PlanConfigurationError {
	readonly plan: string;
	constructor(plan: string, subscriptionId: string) {
		super(`Plan "${plan}" of ${subscriptionId} is not configured`);
		this.name = "PlanNotConfiguredError";
		this.plan = plan;
	}
}

/** A `plans` function returned plans that are not valid. */
export class InvalidPlansError extends PlanConfigurationError {
	constructor(reason: string) {
		super(`Invalid plans: ${reason}`);
		this.name = "InvalidPlansError";
	}
}
