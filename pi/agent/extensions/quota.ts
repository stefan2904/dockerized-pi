import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const GOOGLE_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

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
  entitlement?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
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
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function normalizeProviderConfig(raw: unknown): AuthProviderConfig | undefined {
  return asRecord(raw) as AuthProviderConfig | undefined;
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

type QuotaRow = {
  provider: string;
  account: string;
  plan: string;
  metric: string;
  value: string;
  reset: string;
  progressRemaining?: number;
};

function formatDateUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const dateStr = date.toLocaleDateString([], { day: "2-digit", month: "short" });
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${dateStr} ${timeStr}`;
}

function formatEpochUtc(seconds?: number): string {
  if (!seconds) return "unknown";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "unknown";
  const dateStr = date.toLocaleDateString([], { day: "2-digit", month: "short" });
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${dateStr} ${timeStr}`;
}

function collectGoogleModelRows(provider: string, account: string, plan: string, modelsData?: FetchAvailableModelsResponse): QuotaRow[] {
  if (!modelsData?.models) return [];

  const recommendedIds = new Set(modelsData.agentModelSorts?.[0]?.groups?.flatMap((g) => g.modelIds || []) || []);

  const relevantModels = Object.entries(modelsData.models)
    .filter(([id, info]) => {
      if (!info.quotaInfo) return false;
      return (
        recommendedIds.has(id) ||
        (info.quotaInfo.remainingFraction !== undefined && info.quotaInfo.remainingFraction < 1)
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return relevantModels.map(([id, info]) => {
    const remainingFraction =
      typeof info.quotaInfo?.remainingFraction === "number" ? info.quotaInfo.remainingFraction : undefined;

    return {
      provider,
      account,
      plan,
      metric: id,
      value: remainingFraction !== undefined ? `${(remainingFraction * 100).toFixed(1)}%` : "N/A",
      reset: info.quotaInfo?.resetTime ? formatDateUtc(info.quotaInfo.resetTime) : "unknown",
      progressRemaining: remainingFraction,
    };
  });
}

function codexWindowFields(window?: CodexRateWindow): { value: string; reset: string } {
  if (!window || window.usedPercent === undefined) return { value: "n/a", reset: "unknown" };
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return {
    value: `${(100 - used).toFixed(1)}% rem`,
    reset: formatEpochUtc(window.resetAt),
  };
}

function truncateCell(value: string, maxWidth: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (maxWidth <= 0) return "";
  if (normalized.length <= maxWidth) return normalized;
  if (maxWidth <= 1) return "…";
  return `${normalized.slice(0, maxWidth - 1)}…`;
}

function renderProgressBar(fraction: number, width = 8): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function barValue(row: QuotaRow): string {
  if (typeof row.progressRemaining !== "number") return "-";
  return renderProgressBar(row.progressRemaining);
}

function padVisible(value: string, width: number): string {
  const vis = visibleWidth(value);
  return value + " ".repeat(Math.max(0, width - vis));
}

function renderQuotaTable(theme: any, rows: QuotaRow[], maxWidth?: number): string[] {
  const lines: string[] = [];
  const headers = ["Provider", "Account", "Plan", "Metric", "Value", "Bar", "Reset/Note"] as const;
  const data = rows.map((r) => [r.provider, r.account, r.plan, r.metric, r.value, barValue(r), r.reset]);
  const maxColumnWidths = [14, 18, 12, 14, 14, 8, 14] as const;
  const minColumnWidths = [8, 10, 8, 8, 8, 8, 8] as const;

  const widths = headers.map((header, index) => {
    const contentWidth = Math.max(visibleWidth(header), ...data.map((row) => visibleWidth(row[index])));
    return Math.min(contentWidth, maxColumnWidths[index]);
  });

  const totalWidth = () => widths.reduce((sum, w) => sum + w, 0) + widths.length * 3 + 1;
  if (maxWidth && totalWidth() > maxWidth) {
    const shrinkOrder = [1, 4, 3, 6, 0, 2];
    while (totalWidth() > maxWidth) {
      let reduced = false;
      for (const idx of shrinkOrder) {
        if (widths[idx] > minColumnWidths[idx]) {
          widths[idx] -= 1;
          reduced = true;
          if (totalWidth() <= maxWidth) break;
        }
      }
      if (!reduced) break;
    }
  }

  const separator = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const renderRow = (cols: string[]) => {
    const clamped = cols.map((c, i) => padVisible(truncateToWidth(truncateCell(c, widths[i]), widths[i]), widths[i]));
    const row = `| ${clamped.join(" | ")} |`;
    return maxWidth ? truncateToWidth(row, maxWidth) : row;
  };

  lines.push(theme.fg("accent", theme.bold("Provider Quotas")));
  lines.push(theme.fg("border", maxWidth ? truncateToWidth(separator, maxWidth) : separator));
  lines.push(theme.fg("accent", renderRow([...headers])));
  lines.push(theme.fg("border", maxWidth ? truncateToWidth(separator, maxWidth) : separator));

  let lastProvider: string | undefined;
  for (const row of rows) {
    if (lastProvider !== undefined && row.provider !== lastProvider) {
      lines.push(theme.fg("border", maxWidth ? truncateToWidth(separator, maxWidth) : separator));
    }
    lines.push(renderRow([row.provider, row.account, row.plan, row.metric, row.value, barValue(row), row.reset]));
    lastProvider = row.provider;
  }

  lines.push(theme.fg("border", maxWidth ? truncateToWidth(separator, maxWidth) : separator));
  return lines;
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
          providers.map(async ([provider, rawConfig]) => {
            const config = normalizeProviderConfig(rawConfig);
            if (!config) {
              return {
                provider,
                config: {},
                kind: "error",
                error: "Invalid provider config in auth.json",
              };
            }

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
            const rows: QuotaRow[] = [];

            for (const entry of providerResults) {
              if (entry.kind === "copilot") {
                const data = entry.data;
                const account = data.login || getAccountHint(entry.provider, entry.config);
                const plan = data.copilot_plan || data.sku || "unknown";

                if (data.access_type_sku) {
                  rows.push({ provider: entry.provider, account, plan, metric: "sku", value: data.access_type_sku, reset: "-" });
                }

                if (data.quota_snapshots) {
                  for (const [id, snapshot] of Object.entries(data.quota_snapshots)) {
                    const percentRemaining = typeof snapshot.percent_remaining === "number" ? snapshot.percent_remaining : undefined;
                    const remaining = typeof snapshot.remaining === "number" ? snapshot.remaining : undefined;
                    const entitlement = typeof snapshot.entitlement === "number" ? snapshot.entitlement : undefined;

                    const value = snapshot.unlimited
                      ? "Unlimited"
                      : percentRemaining !== undefined && remaining !== undefined && entitlement !== undefined
                      ? `${percentRemaining.toFixed(1)}% (${remaining}/${entitlement})`
                      : "Partial snapshot data";

                    rows.push({
                      provider: entry.provider,
                      account,
                      plan,
                      metric: id,
                      value,
                      reset: data.quota_reset_date_utc ? formatDateUtc(data.quota_reset_date_utc) : "-",
                    });
                  }
                } else {
                  rows.push({ provider: entry.provider, account, plan, metric: "quota", value: "No snapshot data", reset: "-" });
                }
                continue;
              }

              if (entry.kind === "antigravity" || entry.kind === "gemini-cli") {
                const { loadData, modelsData, modelsError } = entry.data;
                const account = entry.config.email || getAccountHint(entry.provider, entry.config);
                const plan =
                  loadData.currentTier?.name ||
                  loadData.currentTier?.id ||
                  loadData.plan ||
                  loadData.subscriptionPlan ||
                  "unknown";

                if (loadData.availablePromptCredits !== undefined) {
                  rows.push({
                    provider: entry.provider,
                    account,
                    plan,
                    metric: "prompt_credits",
                    value: String(loadData.availablePromptCredits),
                    reset: "-",
                  });
                }

                rows.push(...collectGoogleModelRows(entry.provider, account, plan, modelsData));

                if (modelsError) {
                  rows.push({ provider: entry.provider, account, plan, metric: "model_quotas", value: modelsError, reset: "-" });
                }

                if (loadData.availablePromptCredits === undefined && !modelsData?.models && !modelsError) {
                  rows.push({ provider: entry.provider, account, plan, metric: "quota", value: "No quota data", reset: "-" });
                }
                continue;
              }

              if (entry.kind === "openai-codex") {
                const { accountId, emailFromToken, planFromToken, quota } = entry.data;
                const account = emailFromToken || entry.config.email || accountId || getAccountHint(entry.provider, entry.config);
                const plan = quota.planType || planFromToken || "unknown";

                const primary = codexWindowFields(quota.primary);
                rows.push({ provider: entry.provider, account, plan, metric: "codex_primary", value: primary.value, reset: primary.reset });

                const secondary = codexWindowFields(quota.secondary);
                rows.push({ provider: entry.provider, account, plan, metric: "codex_secondary", value: secondary.value, reset: secondary.reset });

                if (typeof quota.primaryOverSecondaryPercent === "number") {
                  rows.push({
                    provider: entry.provider,
                    account,
                    plan,
                    metric: "primary_over_secondary",
                    value: `${quota.primaryOverSecondaryPercent.toFixed(1)}%`,
                    reset: "-",
                  });
                }

                if (quota.creditsUnlimited) {
                  rows.push({ provider: entry.provider, account, plan, metric: "credits", value: "Unlimited", reset: "-" });
                } else if (quota.creditsHasCredits && typeof quota.creditsBalance === "number") {
                  rows.push({ provider: entry.provider, account, plan, metric: "credits", value: quota.creditsBalance.toFixed(2), reset: "-" });
                }
                continue;
              }

              const account = getAccountHint(entry.provider, entry.config);
              const plan = entry.config.plan || entry.config.subscriptionPlan || "unknown";
              if (entry.kind === "error") {
                rows.push({ provider: entry.provider, account, plan, metric: "error", value: `Failed to fetch quota: ${entry.error}`, reset: "-" });
              } else {
                rows.push({ provider: entry.provider, account, plan, metric: "quota", value: "Unavailable for this provider", reset: "-" });
              }
            }

            if (rows.length === 0) {
              rows.push({ provider: "-", account: "-", plan: "-", metric: "quota", value: "No data", reset: "-" });
            }

            return {
              render: (width: number) => {
                const lines = renderQuotaTable(theme, rows, width);
                lines.push(truncateToWidth(theme.fg("dim", "(Auto-closes in 30s)"), width));
                return lines;
              },
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" }
        );

        const closeTimer = setTimeout(() => ctx.ui.setWidget("quota", undefined), 30000);
        closeTimer.unref?.();
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
