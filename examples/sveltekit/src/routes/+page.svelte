<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import { authClient } from "$lib/auth-client";

	let { data } = $props();

	let name = $state("");
	let email = $state("");
	let password = $state("");
	let message = $state("");
	let busy = $state(false);

	const current = $derived(data.subscriptions[0]);

	async function run(action: () => Promise<{ error: { message?: string } | null }>) {
		busy = true;
		message = "";
		try {
			const { error } = await action();
			if (error) message = error.message ?? "Something went wrong";
			else await invalidateAll();
		} finally {
			busy = false;
		}
	}

	const signUp = () =>
		run(() => authClient.signUp.email({ name: name || email, email, password }));
	const signIn = () => run(() => authClient.signIn.email({ email, password }));
	const signOut = () => run(() => authClient.signOut());

	// New subscriptions and recoveries redirect to Mollie's checkout; plan
	// changes of a running subscription apply without one.
	const choose = (plan: string) =>
		run(() => authClient.subscription.upgrade({ plan, successUrl: "/", cancelUrl: "/" }));
	const cancel = () => run(() => authClient.subscription.cancel({ returnUrl: "/" }));
	const restore = () => run(() => authClient.subscription.restore());

	const date = (value: Date | string | null | undefined) =>
		value ? new Date(value).toLocaleDateString() : "—";
</script>

<svelte:head><title>better-auth-mollie · SvelteKit</title></svelte:head>

<main>
	<h1>better-auth-mollie</h1>

	{#if message}<p class="error">{message}</p>{/if}

	{#if !data.user}
		<form onsubmit={(e) => e.preventDefault()}>
			<input placeholder="Name" bind:value={name} autocomplete="name" />
			<input placeholder="Email" type="email" bind:value={email} autocomplete="email" required />
			<input
				placeholder="Password (8+ characters)"
				type="password"
				bind:value={password}
				autocomplete="current-password"
				required
			/>
			<div class="row">
				<button disabled={busy} onclick={signIn}>Sign in</button>
				<button disabled={busy} onclick={signUp}>Create account</button>
			</div>
		</form>
	{:else}
		<p>
			Signed in as <strong>{data.user.email}</strong>
			<button class="link" disabled={busy} onclick={signOut}>Sign out</button>
		</p>

		{#if current}
			<section class="card">
				<h2>Your subscription</h2>
				<dl>
					<dt>Plan</dt>
					<dd>{current.plan}</dd>
					<dt>Status</dt>
					<dd>{current.status}</dd>
					<dt>{current.status === "trialing" ? "Trial ends" : "Current period ends"}</dt>
					<dd>{date(current.periodEnd)}</dd>
					{#if current.pendingPlan}
						<dt>Next period</dt>
						<dd>{current.pendingPlan}</dd>
					{/if}
				</dl>
				{#if current.status === "past_due"}
					<p class="error">
						Your last payment failed. Pay with another method to keep access:
						<button disabled={busy} onclick={() => choose(current.plan)}>Pay now</button>
					</p>
				{/if}
				{#if current.cancelAtPeriodEnd}
					<p>Canceled: access ends on {date(current.periodEnd)}.</p>
					<button disabled={busy} onclick={restore}>Keep my subscription</button>
				{:else}
					<button disabled={busy} onclick={cancel}>Cancel subscription</button>
				{/if}
			</section>
		{/if}

		<section class="plans">
			{#each data.plans as plan}
				<article class="card">
					<h3>{plan.description ?? plan.name}</h3>
					<p>€{plan.amount} + VAT / {plan.interval}</p>
					{#if plan.freeTrial}<p>{plan.freeTrial.days}-day free trial</p>{/if}
					{#if current?.plan === plan.name}
						<p><em>Current plan</em></p>
					{:else}
						<button disabled={busy} onclick={() => choose(plan.name)}>
							{current ? "Switch" : "Subscribe"}
						</button>
					{/if}
				</article>
			{/each}
		</section>
		<p class="hint">
			Upgrades apply right away and charge the pro-rata difference; downgrades start next period.
			Test mode: pay with card 4543 4740 0224 9996, any future date and CVC.
		</p>
	{/if}
</main>

<style>
	main {
		max-width: 52rem;
		margin: 2rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}
	form,
	.card {
		display: grid;
		gap: 0.5rem;
		padding: 1rem;
		border: 1px solid #ddd;
		border-radius: 0.5rem;
	}
	form {
		max-width: 22rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 1rem;
		margin-top: 1rem;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 1rem;
		margin: 0;
	}
	dt {
		color: #666;
	}
	.error {
		color: #b00020;
	}
	.hint {
		color: #666;
		font-size: 0.9rem;
	}
	.link {
		background: none;
		border: none;
		color: #0060df;
		cursor: pointer;
	}
</style>
