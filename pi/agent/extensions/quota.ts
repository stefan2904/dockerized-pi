import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const GOOGLE_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const INFO_LABEL_WIDTH = 8;
const METRIC_LABEL_WIDTH = 20;

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface AuthProviderConfig {
  access?: string;
  refresh?: string;
  projectId?: string;
  email?: string;
  accountId?: string;
  plan?: string;
  subscriptionPlan?: string;
  login?: string;
  [key: string]: unknown;
}

interface AuthFile {
  [provider: string]: AuthProviderConfig;
}

interface QuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
  isExhausted?: boolean;
}

interface ModelInfo {
  quotaInfo?: QuotaInfo;
}

interface ModelSortGroup {
  modelIds?: string[];
}

interface ModelSort {
  groups?: ModelSortGroup[];
}

interface FetchAvailableModelsResponse {
  models?: Record<string, ModelInfo>;
  agentModelSorts?: ModelSort[];
}

interface GoogleTierInfo {
  id?: string;
  name?: string;
}

interface GoogleLoadCodeAssistResponse {
  availablePromptCredits?: number;
  cloudaicompanionProject?: string | { id?: string };
  plan?: string;
  subscriptionPlan?: string;
  currentTier?: GoogleTierInfo;
}

interface QuotaSnapshot {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
}

interface CopilotUserResponse {
  login: string;
  copilot_plan?: string;
  sku?: string;
  access_type_sku?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, QuotaSnapshot>;
}

interface CodexRateWindow {
  usedPercent?: number;
  resetAt?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
}

interface CodexProbeQuota {
  planType?: string;
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
  primaryOverSecondaryPercent?: number;
  creditsUnlimited?: boolean;
  creditsHasCredits?: boolean;
  creditsBalance?: number;
}

function loadAuth(): AuthFile {
  if (!fs.existsSync(AUTH_PATH)) {
    throw new Error(`auth.json not found at ${AUTH_PATH}`);
  }
  return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")) as AuthFile;
}

function getAccountHint(provider: string, config: AuthProviderConfig): string {
  return config.email || config.login || config.accountId || provider;
}

function decodeJwtPayload(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

async function fetchCopilotQuota(config: AuthProviderConfig): Promise<CopilotUserResponse> {
  if (!config.refresh) {
    throw new Error("missing refresh token");
  }

  const response = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `Bearer ${config.refresh}`,
      ...COPILOT_HEADERS,
    },
  });

  if (!response.ok) {
    throw new Error(`fetch failed (${response.status})`);
  }

  return (await response.json()) as CopilotUserResponse;
}

async function fetchGoogleQuota(config: AuthProviderConfig, ideType: "ANTIGRAVITY" | "IDE_UNSPECIFIED") {
  if (!config.access) {
    throw new Error("missing access token");
  }

  const headers = {
    Authorization: `Bearer ${config.access}`,
    "Content-Type": "application/json",
    "User-Agent": ideType === "ANTIGRAVITY" ? "antigravity" : "google-api-nodejs-client/9.15.1",
    ...(ideType === "IDE_UNSPECIFIED" ? { "X-Goog-Api-Client": "gl-node/22.17.0" } : {}),
  };

  const loadBody: Record<string, unknown> = {
    metadata: {
      ideType,
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  };

  if (ideType === "IDE_UNSPECIFIED" && config.projectId) {
    loadBody.cloudaicompanionProject = config.projectId;
    (loadBody.metadata as Record<string, unknown>).duetProject = config.projectId;
  }

  const loadResponse = await fetch(`${GOOGLE_BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify(loadBody),
  });

  if (!loadResponse.ok) {
    throw new Error(`loadCodeAssist failed (${loadResponse.status})`);
  }

  const loadData = (await loadResponse.json()) as GoogleLoadCodeAssistResponse;
  const resolvedProjectId =
    config.projectId ||
    (typeof loadData.cloudaicompanionProject === "string"
      ? loadData.cloudaicompanionProject
      : loadData.cloudaicompanionProject?.id);

  let modelsData: FetchAvailableModelsResponse | undefined;
  let modelsError: string | undefined;

  if (resolvedProjectId) {
    const modelsResponse = await fetch(`${GOOGLE_BASE_URL}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project: resolvedProjectId }),
    });

    if (modelsResponse.ok) {
      modelsData = (await modelsResponse.json()) as FetchAvailableModelsResponse;
    } else {
      modelsError = `fetchAvailableModels failed (${modelsResponse.status})`;
    }
  }

  return { loadData, modelsData, modelsError };
}

function parseHeaderNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseHeaderBool(value: string | null): boolean | undefined {
  if (!value) return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function parseCodexWindow(headers: Headers, prefix: "x-codex-primary" | "x-codex-secondary"): CodexRateWindow {
  return {
    usedPercent: parseHeaderNumber(headers.get(`${prefix}-used-percent`)),
    resetAt: parseHeaderNumber(headers.get(`${prefix}-reset-at`)),
    resetAfterSeconds: parseHeaderNumber(headers.get(`${prefix}-reset-after-seconds`)),
    windowMinutes: parseHeaderNumber(headers.get(`${prefix}-window-minutes`)),
  };
}

async function fetchOpenAICodexQuota(config: AuthProviderConfig) {
  if (!config.access) {
    throw new Error("missing access token");
  }

  const jwt = decodeJwtPayload(config.access);
  const authClaim = asRecord(jwt?.[OPENAI_AUTH_CLAIM]);
  const profileClaim = asRecord(jwt?.[OPENAI_PROFILE_CLAIM]);
  const accountId =
    config.accountId ||
    (typeof authClaim?.chatgpt_account_id === "string" ? authClaim.chatgpt_account_id : undefined);

  if (!accountId) {
    throw new Error("missing account id");
  }

  const headers = {
    Authorization: `Bearer ${config.access}`,
    "chatgpt-account-id": accountId,
    originator: "pi",
    "OpenAI-Beta": "responses=experimental",
    "User-Agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
    accept: "text/event-stream",
    "content-type": "application/json",
  };

  const probeBody = {
    model: "gpt-5.3-codex",
    store: false,
    stream: true,
    instructions: "You are a quota probe.",
    input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    text: { verbosity: "low" as const },
  };

  const response = await fetch(`${CHATGPT_BASE_URL}/codex/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(probeBody),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`codex probe failed (${response.status}): ${body.slice(0, 180)}`);
  }

  // We only need headers; cancel stream to minimize output processing.
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }

  const quota: CodexProbeQuota = {
    planType: response.headers.get("x-codex-plan-type") || undefined,
    primary: parseCodexWindow(response.headers, "x-codex-primary"),
    secondary: parseCodexWindow(response.headers, "x-codex-secondary"),
    primaryOverSecondaryPercent: parseHeaderNumber(response.headers.get("x-codex-primary-over-secondary-limit-percent")),
    creditsUnlimited: parseHeaderBool(response.headers.get("x-codex-credits-unlimited")),
    creditsHasCredits: parseHeaderBool(response.headers.get("x-codex-credits-has-credits")),
    creditsBalance: parseHeaderNumber(response.headers.get("x-codex-credits-balance")),
  };

  return {
    accountId,
    emailFromToken: typeof profileClaim?.email === "string" ? profileClaim.email : undefined,
    planFromToken: typeof authClaim?.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : undefined,
    quota,
  };
}

type ProviderResult =
  | { provider: string; config: AuthProviderConfig; kind: "copilot"; data: CopilotUserResponse }
  | {
      provider: string;
      config: AuthProviderConfig;
      kind: "antigravity" | "gemini-cli";
      data: {
        loadData: GoogleLoadCodeAssistResponse;
        modelsData?: FetchAvailableModelsResponse;
        modelsError?: string;
      };
    }
  | {
      provider: string;
      config: AuthProviderConfig;
      kind: "openai-codex";
      data: {
        accountId: string;
        emailFromToken?: string;
        planFromToken?: string;
        quota: CodexProbeQuota;
      };
    }
  | { provider: string; config: AuthProviderConfig; kind: "error"; error: string }
  | { provider: string; config: AuthProviderConfig; kind: "unsupported" };

function renderGoogleModelLines(lines: string[], theme: any, modelsData?: FetchAvailableModelsResponse) {
  if (!modelsData?.models) return;

  const recommendedIds = new Set(modelsData.agentModelSorts?.[0]?.groups?.flatMap((g) => g.modelIds || []) || []);

  const relevantModels = Object.entries(modelsData.models)
    .filter(([id, info]) => {
      if (!info.quotaInfo) return false;
      return (
        recommendedIds.has(id) ||
        (info.quotaInfo.remainingFraction !== undefined && info.quotaInfo.remainingFraction < 1)
      );
    })
    .sort((a, b) => (a[1].quotaInfo?.remainingFraction ?? 1) - (b[1].quotaInfo?.remainingFraction ?? 1));

  if (relevantModels.length === 0) return;

  const longest = Math.max(METRIC_LABEL_WIDTH, relevantModels.reduce((max, [id]) => Math.max(max, id.length), 12));

  for (const [id, info] of relevantModels) {
    const remainingVal = info.quotaInfo?.remainingFraction;
    const remaining = remainingVal !== undefined ? `${(remainingVal * 100).toFixed(1)}%` : "N/A";
    const resetDate = info.quotaInfo?.resetTime ? new Date(info.quotaInfo.resetTime) : undefined;

    let resetStr = "Unknown";
    if (resetDate) {
      const timeStr = resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      const dateStr = resetDate.toLocaleDateString([], { day: "2-digit", month: "short" });
      resetStr = `${dateStr} ${timeStr}`;
    }

    let color: "text" | "error" | "warning" = "text";
    if (info.quotaInfo?.isExhausted || (remainingVal !== undefined && remainingVal < 0.1)) color = "error";
    else if (remainingVal !== undefined && remainingVal < 0.5) color = "warning";

    lines.push(
      `${theme.fg("dim", id.padEnd(longest))}: ${theme.fg(color, remaining.padStart(6))}  reset ${theme.fg("dim", resetStr)}`
    );
  }
}

function windowLine(theme: any, id: string, window?: CodexRateWindow): string {
  if (!window || window.usedPercent === undefined) {
    return `${theme.fg("dim", id.padEnd(METRIC_LABEL_WIDTH))}: ${theme.fg("dim", "n/a")}`;
  }

  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remaining = `${(100 - used).toFixed(1)}%`;

  let color: "text" | "error" | "warning" = "text";
  if (remaining === "0.0%") color = "error";
  else if (used >= 50) color = "warning";

  const resetAt = window.resetAt ? new Date(window.resetAt * 1000) : undefined;
  const resetStr = resetAt
    ? resetAt.toLocaleDateString([], { day: "2-digit", month: "short" }) +
      " " +
      resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "unknown";

  return `${theme.fg("dim", id.padEnd(METRIC_LABEL_WIDTH))}: ${theme.fg(color, remaining.padStart(6))} rem, reset ${theme.fg("dim", resetStr)}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quota", {
    description: "Show usage quotas for all logged-in providers",
    handler: async (_args, ctx) => {
      try {
        const auth = loadAuth();
        const providers = Object.entries(auth);

        if (providers.length === 0) {
          ctx.ui.notify("No logged-in providers found", "warning");
          return;
        }

        ctx.ui.notify("Fetching quotas...", "info");

        const providerResults: ProviderResult[] = await Promise.all(
          providers.map(async ([provider, config]) => {
            try {
              if (provider === "github-copilot") {
                return { provider, config, kind: "copilot", data: await fetchCopilotQuota(config) };
              }
              if (provider === "google-antigravity") {
                return {
                  provider,
                  config,
                  kind: "antigravity",
                  data: await fetchGoogleQuota(config, "ANTIGRAVITY"),
                };
              }
              if (provider === "google-gemini-cli") {
                return {
                  provider,
                  config,
                  kind: "gemini-cli",
                  data: await fetchGoogleQuota(config, "IDE_UNSPECIFIED"),
                };
              }
              if (provider === "openai-codex") {
                return {
                  provider,
                  config,
                  kind: "openai-codex",
                  data: await fetchOpenAICodexQuota(config),
                };
              }
              return { provider, config, kind: "unsupported" };
            } catch (error) {
              return {
                provider,
                config,
                kind: "error",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );

        ctx.ui.setWidget(
          "quota",
          (_tui, theme) => {
            const lines: string[] = [];
            const info = (label: string, value: string) => {
              lines.push(`${label.padEnd(INFO_LABEL_WIDTH)}: ${theme.fg("success", value)}`);
            };
            const metric = (name: string) => theme.fg("dim", name.padEnd(METRIC_LABEL_WIDTH));

            lines.push(theme.fg("accent", theme.bold("Provider Quotas:")));
            lines.push(theme.fg("border", "================"));

            for (const entry of providerResults) {
              lines.push("");
              lines.push(theme.fg("accent", theme.bold(entry.provider)));

              if (entry.kind === "copilot") {
                const data = entry.data;
                info("Account", data.login || getAccountHint(entry.provider, entry.config));
                info("Plan", data.copilot_plan || data.sku || "unknown");
                if (data.access_type_sku) {
                  info("SKU", data.access_type_sku);
                }

                if (data.quota_snapshots) {
                  for (const [id, snapshot] of Object.entries(data.quota_snapshots)) {
                    if (snapshot.unlimited) {
                      lines.push(`${metric(id)}: ${theme.fg("success", "Unlimited")}`);
                      continue;
                    }

                    const remaining = snapshot.percent_remaining.toFixed(1) + "%";
                    let color: "text" | "error" | "warning" = "text";
                    if (snapshot.percent_remaining < 10) color = "error";
                    else if (snapshot.percent_remaining < 50) color = "warning";

                    lines.push(
                      `${metric(id)}: ${theme.fg(color, remaining.padStart(6))} (${snapshot.remaining}/${snapshot.entitlement})`
                    );
                  }
                }

                if (data.quota_reset_date_utc) {
                  const resetDate = new Date(data.quota_reset_date_utc);
                  const dateStr = resetDate.toLocaleDateString([], { day: "2-digit", month: "short" });
                  lines.push(`${metric("Next Reset")}: ${dateStr}`);
                }
                continue;
              }

              if (entry.kind === "antigravity" || entry.kind === "gemini-cli") {
                const { loadData, modelsData, modelsError } = entry.data;
                const plan =
                  loadData.currentTier?.name ||
                  loadData.currentTier?.id ||
                  loadData.plan ||
                  loadData.subscriptionPlan ||
                  "unknown";

                info("Account", entry.config.email || getAccountHint(entry.provider, entry.config));
                info("Plan", plan);

                if (loadData.availablePromptCredits !== undefined) {
                  lines.push(
                    `${metric("prompt_credits")}: ${theme.fg("success", String(loadData.availablePromptCredits))}`
                  );
                }

                renderGoogleModelLines(lines, theme, modelsData);
                if (modelsError) {
                  lines.push(`${metric("model_quotas")}: ${theme.fg("dim", modelsError)}`);
                }
                continue;
              }

              if (entry.kind === "openai-codex") {
                const { accountId, emailFromToken, planFromToken, quota } = entry.data;
                const account = emailFromToken || entry.config.email || accountId || getAccountHint(entry.provider, entry.config);
                const plan = quota.planType || planFromToken || "unknown";

                info("Account", account);
                info("Plan", plan);

                lines.push(windowLine(theme, "codex_primary", quota.primary));
                lines.push(windowLine(theme, "codex_secondary", quota.secondary));

                if (typeof quota.primaryOverSecondaryPercent === "number") {
                  lines.push(
                    `${metric("primary_over_secondary")}: ${theme.fg(
                      "dim",
                      `${quota.primaryOverSecondaryPercent.toFixed(1)}%`
                    )}`
                  );
                }

                if (quota.creditsUnlimited) {
                  lines.push(`${metric("credits")}: ${theme.fg("success", "Unlimited")}`);
                } else if (quota.creditsHasCredits && typeof quota.creditsBalance === "number") {
                  lines.push(`${metric("credits")}: ${theme.fg("success", quota.creditsBalance.toFixed(2))}`);
                }
                continue;
              }

              info("Account", getAccountHint(entry.provider, entry.config));
              if (entry.kind === "error") {
                lines.push(`${theme.fg("error", `Failed to fetch quota: ${entry.error}`)}`);
              } else {
                const plan = entry.config.plan || entry.config.subscriptionPlan;
                if (plan) info("Plan", plan);
                lines.push(theme.fg("dim", "Quota details unavailable for this provider"));
              }
            }

            return {
              render: () => lines,
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" }
        );

        setTimeout(() => ctx.ui.setWidget("quota", undefined), 60000);
      } catch (error) {
        ctx.ui.notify(`Error fetching quotas: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "get_gemini_cli_quota",
    label: "Get Gemini CLI Quota",
    description: "Fetch Google Gemini CLI tier info and model quota availability.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const auth = loadAuth();
        const config = auth["google-gemini-cli"];
        if (!config) throw new Error("google-gemini-cli config not found in auth.json");
        const data = await fetchGoogleQuota(config, "IDE_UNSPECIFIED");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "get_openai_codex_quota",
    label: "Get OpenAI Codex Quota",
    description: "Probe OpenAI Codex quota headers and account plan details.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const auth = loadAuth();
        const config = auth["openai-codex"];
        if (!config) throw new Error("openai-codex config not found in auth.json");
        const data = await fetchOpenAICodexQuota(config);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  });
}
