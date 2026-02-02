import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface QuotaSnapshot {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
  quota_id: string;
}

interface CopilotUserResponse {
  copilot_plan: string;
  sku: string;
  quota_reset_date_utc: string;
  quota_snapshots?: Record<string, QuotaSnapshot>;
}

async function fetchCopilotQuota() {
  if (!fs.existsSync(AUTH_PATH)) {
    throw new Error(`auth.json not found at ${AUTH_PATH}`);
  }

  const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  const copilot = auth["github-copilot"];

  if (!copilot || !copilot.refresh) {
    throw new Error("github-copilot config not found in auth.json");
  }

  const refreshToken = copilot.refresh;

  const response = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Copilot quota: ${response.status}`);
  }

  return (await response.json()) as CopilotUserResponse;
}

export default function (pi: ExtensionAPI) {
  // Register /quota-copilot command
  pi.registerCommand("quota-copilot", {
    description: "Show GitHub Copilot usage statistics and quotas",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify("Fetching Copilot quota...", "info");
        const data = await fetchCopilotQuota();

        ctx.ui.setWidget(
          "copilot-quota",
          (_tui, theme) => {
            const lines: string[] = [];
            lines.push(theme.fg("accent", theme.bold("GitHub Copilot Quotas:")));
            lines.push(theme.fg("border", "========================="));
            lines.push(`Plan: ${theme.fg("success", data.copilot_plan)}`);

            if (data.quota_snapshots) {
              for (const [id, snapshot] of Object.entries(data.quota_snapshots)) {
                if (snapshot.unlimited) {
                  lines.push(`${theme.fg("dim", id.padEnd(20))}: ${theme.fg("success", "Unlimited")}`);
                  continue;
                }

                const remaining = snapshot.percent_remaining.toFixed(1) + "%";
                let color: "text" | "error" | "warning" = "text";
                if (snapshot.percent_remaining < 10) {
                  color = "error";
                } else if (snapshot.percent_remaining < 50) {
                  color = "warning";
                }

                lines.push(
                  `${theme.fg("dim", id.padEnd(20))}: ${theme.fg(color, remaining.padStart(6))} (${snapshot.remaining}/${
                    snapshot.entitlement
                  })`
                );
              }
            }

            if (data.quota_reset_date_utc) {
              const resetDate = new Date(data.quota_reset_date_utc);
              const dateStr = resetDate.toLocaleDateString([], { day: "2-digit", month: "short" });
              lines.push("");
              lines.push(`${theme.fg("dim", "Next Reset".padEnd(20))}: ${dateStr}`);
            }

            return {
              render: () => lines,
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" }
        );
        setTimeout(() => ctx.ui.setWidget("copilot-quota", undefined), 60000); // Clear after 60s
      } catch (error) {
        ctx.ui.notify(`Error fetching Copilot quota: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Register tool for the LLM
  pi.registerTool({
    name: "get_copilot_quota",
    label: "Get Copilot Quota",
    description: "Fetch current GitHub Copilot usage limits and quotas.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const data = await fetchCopilotQuota();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
          details: data,
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
