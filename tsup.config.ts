import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		client: "src/client.ts",
		vat: "src/vat.ts",
	},
	format: ["esm"],
	target: "es2022",
	platform: "neutral",
	dts: true,
	clean: true,
	sourcemap: true,
	treeshake: true,
	splitting: true,
	external: ["better-auth", "mollie-api-typescript", "zod", "sales-tax"],
});
