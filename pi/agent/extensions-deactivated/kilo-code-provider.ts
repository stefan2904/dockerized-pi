import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "kilo-code";
const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";
const KILO_MODELS_URL = `${KILO_BASE_URL}/models`;
const KILO_API_KEY_ENV = "KILO_API_KEY";

type InputModality = "text" | "image";

type KiloModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: InputModality[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		maxTokensField: "max_tokens";
		supportsDeveloperRole: false;
		supportsReasoningEffort: false;
		supportsUsageInStreaming: false;
	};
};

interface KiloGatewayModel {
	id?: string;
	name?: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number | null;
	};
	supported_parameters?: string[];
	preferredIndex?: number;
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		cache_read?: string | number;
		cache_write?: string | number;
		[input: string]: string | number | undefined;
	};
}

interface KiloGatewayModelsResponse {
	data?: KiloGatewayModel[];
}

const DEFAULT_COMPAT: KiloModelConfig["compat"] = {
	maxTokensField: "max_tokens",
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
};

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value <= 0) return undefined;
	return Math.floor(value);
}

function resolveContextWindow(model: KiloGatewayModel): number {
	return asPositiveInt(model.context_length) || asPositiveInt(model.top_provider?.context_length) || 128000;
}

function resolveMaxTokens(model: KiloGatewayModel, contextWindow: number): number {
	const providerMax = asPositiveInt(model.top_provider?.max_completion_tokens);
	if (providerMax) return providerMax;
	const estimated = Math.floor(contextWindow / 4);
	return Math.max(4096, Math.min(estimated, 65536));
}

function resolveInputModalities(model: KiloGatewayModel): InputModality[] {
	const input = model.architecture?.input_modalities || [];
	if (input.some((m) => m === "image")) {
		return ["text", "image"];
	}
	return ["text"];
}

function supportsReasoning(model: KiloGatewayModel): boolean {
	const params = model.supported_parameters || [];
	return params.includes("reasoning") || params.includes("include_reasoning");
}

function toModelConfig(model: KiloGatewayModel): KiloModelConfig | undefined {
	const id = model.id?.trim();
	if (!id) return undefined;

	const contextWindow = resolveContextWindow(model);
	const maxTokens = resolveMaxTokens(model, contextWindow);

	return {
		id,
		name: model.name?.trim() || id,
		reasoning: supportsReasoning(model),
		input: resolveInputModalities(model),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: DEFAULT_COMPAT,
	};
}

function isFreeModel(model: KiloGatewayModel): boolean {
	const pricing = model.pricing;
	if (!pricing) return false;

	// Check all pricing fields are 0
	for (const value of Object.values(pricing)) {
		if (value === undefined) continue;
		const num = typeof value === "string" ? parseFloat(value) : value;
		if (!Number.isFinite(num) || num !== 0) return false;
	}
	return true;
}

async function fetchKiloModels(): Promise<KiloModelConfig[]> {
	const response = await fetch(KILO_MODELS_URL, {
		headers: {
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`failed to fetch models (${response.status})`);
	}

	const payload = (await response.json()) as KiloGatewayModelsResponse;
	const data = payload.data || [];

	const models = data
		.slice()
		.sort((a, b) => {
			const ai = asPositiveInt(a.preferredIndex) ?? Number.MAX_SAFE_INTEGER;
			const bi = asPositiveInt(b.preferredIndex) ?? Number.MAX_SAFE_INTEGER;
			if (ai !== bi) return ai - bi;
			return (a.name || a.id || "").localeCompare(b.name || b.id || "");
		})
		.map(toModelConfig)
		.filter((model): model is KiloModelConfig => Boolean(model));

	if (models.length === 0) {
		throw new Error("gateway returned zero models");
	}

	return models;
}

function registerKiloProvider(pi: ExtensionAPI, models: KiloModelConfig[]): void {
	pi.registerProvider(PROVIDER_NAME, {
		baseUrl: KILO_BASE_URL,
		apiKey: KILO_API_KEY_ENV,
		api: "openai-completions",
		models,
	});
}

export default async function (pi: ExtensionAPI) {
	const models = await fetchKiloModels();
	registerKiloProvider(pi, models);

	pi.registerCommand("kilo-refresh-models", {
		description: "Refresh Kilo Code model catalog from Kilo Gateway",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Refreshing Kilo Code models...", "info");

			try {
				const refreshedModels = await fetchKiloModels();
				registerKiloProvider(pi, refreshedModels);
				ctx.ui.notify(`Loaded ${refreshedModels.length} Kilo Code models`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh Kilo models: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("kilo-list-free-models", {
		description: "List all Kilo Code models that are currently free (all pricing fields are 0)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Fetching Kilo Code models...", "info");

			try {
				const response = await fetch(KILO_MODELS_URL, {
					headers: { Accept: "application/json" },
				});

				if (!response.ok) {
					throw new Error(`failed to fetch models (${response.status})`);
				}

				const payload = (await response.json()) as KiloGatewayModelsResponse;
				const data = payload.data || [];

				const freeModels = data.filter(isFreeModel);

				if (freeModels.length === 0) {
					ctx.ui.notify("No free models found", "info");
					return;
				}

				// Sort by name for consistent output
				freeModels.sort((a, b) =>
					(a.name || a.id || "").localeCompare(b.name || b.id || "")
				);

				const lines: string[] = [];
				lines.push(`Free Kilo Code models (${freeModels.length}):\n`);

				// Calculate column widths
				const names = freeModels.map(m => m.name || m.id || "unknown");
				const ids = freeModels.map(m => m.id || "unknown");
				const contexts = freeModels.map(m => String(m.context_length || m.top_provider?.context_length || "?"));

				const nameWidth = Math.max(4, ...names.map(n => n.length));
				const idWidth = Math.max(2, ...ids.map(i => i.length));
				const ctxWidth = Math.max(7, ...contexts.map(c => c.length));

				// Header
				lines.push(`  ${"Name".padEnd(nameWidth)}  ${"ID".padEnd(idWidth)}  Context`);
				lines.push(`  ${"-".repeat(nameWidth)}  ${"-".repeat(idWidth)}  ${"-".repeat(ctxWidth)}`);

				// Rows
				for (let i = 0; i < freeModels.length; i++) {
					const name = names[i].padEnd(nameWidth);
					const id = ids[i].padEnd(idWidth);
					const ctx = contexts[i];
					lines.push(`  ${name}  ${id}  ${ctx}`);
				}

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to list free models: ${message}`, "error");
			}
		},
	});
}
