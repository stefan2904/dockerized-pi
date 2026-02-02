import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const BASE_URL = "https://cloudcode-pa.googleapis.com";

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

interface LoadCodeAssistResponse {
  availablePromptCredits?: number;
  cloudaicompanionProject?: string | { id?: string };
}

async function fetchQuota() {
  if (!fs.existsSync(AUTH_PATH)) {
    throw new Error(`auth.json not found at ${AUTH_PATH}`);
  }

  const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  const ag = auth["google-antigravity"];

  if (!ag || !ag.access) {
    throw new Error("google-antigravity config not found in auth.json");
  }

  const accessToken = ag.access;
  const projectId = ag.projectId;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "antigravity",
  };

  // 1. loadCodeAssist to ensure session is active/warm
  const loadResponse = await fetch(`${BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!loadResponse.ok) {
    throw new Error(`Failed to loadCodeAssist: ${loadResponse.status}`);
  }

  const loadData = (await loadResponse.json()) as LoadCodeAssistResponse;
  const resolvedProjectId =
    projectId ||
    (typeof loadData.cloudaicompanionProject === "string"
      ? loadData.cloudaicompanionProject
      : loadData.cloudaicompanionProject?.id);

  // 2. fetchAvailableModels for quota info
  const modelsResponse = await fetch(`${BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: resolvedProjectId }),
  });

  if (!modelsResponse.ok) {
    throw new Error(`Failed to fetchAvailableModels: ${modelsResponse.status}`);
  }

  const modelsData = (await modelsResponse.json()) as FetchAvailableModelsResponse;
  return { loadData, modelsData };
}

export default function (pi: ExtensionAPI) {
  // Register /quota command
  pi.registerCommand("quota", {
    description: "Show Antigravity usage limits and quotas",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify("Fetching Antigravity quota...", "info");
        const { loadData, modelsData } = await fetchQuota();

        ctx.ui.setWidget(
          "antigravity-quota",
          (_tui, theme) => {
            const lines: string[] = [];
            lines.push(theme.fg("accent", theme.bold("Antigravity Usage Limits:")));
            lines.push(theme.fg("border", "========================="));

            if (loadData.availablePromptCredits !== undefined) {
              lines.push(`Available Prompt Credits: ${theme.fg("success", loadData.availablePromptCredits.toString())}`);
            }

            if (modelsData.models) {
              lines.push("");
              lines.push(theme.fg("accent", theme.bold("Model Quotas:")));
              lines.push(theme.fg("border", "-------------"));

              const recommendedIds = new Set(
                modelsData.agentModelSorts?.[0]?.groups?.flatMap((g) => g.modelIds || []) || []
              );

              const relevantModels = Object.entries(modelsData.models)
                .filter(([id, info]) => {
                  if (!info.quotaInfo) return false;
                  // Show if recommended or if it's being used/exhausted
                  return (
                    recommendedIds.has(id) ||
                    (info.quotaInfo.remainingFraction !== undefined && info.quotaInfo.remainingFraction < 1)
                  );
                })
                .sort((a, b) => {
                  const fractionA = a[1].quotaInfo?.remainingFraction ?? 1;
                  const fractionB = b[1].quotaInfo?.remainingFraction ?? 1;
                  return fractionA - fractionB; // Lower fraction first
                });

              for (const [id, info] of relevantModels) {
                const remainingVal = info.quotaInfo!.remainingFraction;
                const remaining = remainingVal !== undefined ? (remainingVal * 100).toFixed(1) + "%" : "N/A";

                const resetDate = info.quotaInfo!.resetTime ? new Date(info.quotaInfo!.resetTime) : null;
                let resetStr = "Unknown";
                if (resetDate) {
                  const timeStr = resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  const isToday = resetDate.toDateString() === new Date().toDateString();
                  resetStr = isToday ? timeStr : `${resetDate.getMonth() + 1}/${resetDate.getDate()} ${timeStr}`;
                }

                const isExhausted = info.quotaInfo!.isExhausted;
                let color: "text" | "error" | "warning" = "text";
                if (isExhausted || (remainingVal !== undefined && remainingVal < 0.1)) {
                  color = "error";
                } else if (remainingVal !== undefined && remainingVal < 0.5) {
                  color = "warning";
                }

                const idStr = id.length > 20 ? id.substring(0, 17) + "..." : id.padEnd(20);
                lines.push(
                  `${theme.fg("dim", idStr)}: ${theme.fg(color, remaining.padStart(6))} rem, reset: ${theme.fg(
                    "dim",
                    resetStr
                  )}${isExhausted ? theme.fg("error", " (EX)") : ""}`
                );
              }
            }

            return {
              render: () => lines,
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" }
        );
        setTimeout(() => ctx.ui.setWidget("antigravity-quota", undefined), 60000); // Clear after 60s
      } catch (error) {
        ctx.ui.notify(`Error fetching quota: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Register /quota-full command
  pi.registerCommand("quota-full", {
    description: "Display the full JSON response from the Antigravity quota API",
    parameters: Type.Object({
      filename: Type.Optional(Type.String({ description: "Optional filename to write the JSON to" })),
    }),
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify("Fetching Antigravity quota (full)...", "info");
        const { loadData, modelsData } = await fetchQuota();
        const fullJson = JSON.stringify({ loadData, modelsData }, null, 2);

        if (args.filename) {
          fs.writeFileSync(args.filename, fullJson, "utf8");
          ctx.ui.notify(`Quota JSON written to ${args.filename}`, "info");
        } else if (ctx.hasUI) {
          await ctx.ui.editor("Antigravity Quota (Full JSON)", fullJson);
        } else {
          console.log(fullJson);
        }
      } catch (error) {
        ctx.ui.notify(`Error fetching quota: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Register tool for the LLM
  pi.registerTool({
    name: "get_antigravity_quota",
    label: "Get Antigravity Quota",
    description: "Fetch current Antigravity usage limits and model quotas.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const { loadData, modelsData } = await fetchQuota();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ loadData, modelsData }, null, 2),
            },
          ],
          details: { loadData, modelsData },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
