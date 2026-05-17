import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "switch_model",
    label: "Switch Model",
    description: "Switch the current AI model to a different one. Only permitted models can be selected.",
    parameters: Type.Object({
      modelId: Type.String({ description: "The full ID of the model to switch to (e.g., 'kilo-code/kilo-auto/free')" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // 1. Load settings to find enabled models
      const settingsPath = join(homedir(), ".pi/agent/settings.json");
      let enabledModels: string[] = [];
      try {
        const settingsContent = await readFile(settingsPath, "utf8");
        const settings = JSON.parse(settingsContent);
        enabledModels = settings.enabledModels || [];
      } catch (err) {
        throw new Error(`Failed to read settings: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Validate modelId
      if (!enabledModels.includes(params.modelId)) {
        return {
          content: [{ 
            type: "text", 
            text: `Model '${params.modelId}' is not in the list of enabled models. Available models: ${enabledModels.join(", ")}` 
          }],
          isError: true,
        };
      }

      // 3. Find model in registry
      // The settings.json stores "provider/modelId". We need to split them.
      const [provider, ...rest] = params.modelId.split("/");
      const id = rest.join("/");

      const model = ctx.modelRegistry.find(provider, id);
      if (!model) {
        return {
          content: [{ type: "text", text: `Model '${params.modelId}' not found in the model registry.` }],
          isError: true,
        };
      }

      // 4. Set the model
      const success = await pi.setModel(model);
      if (!success) {
        return {
          content: [{ type: "text", text: `Failed to switch to '${params.modelId}'. Ensure you have the necessary API keys configured.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `Successfully switched model to ${params.modelId}` }],
        details: { modelId: params.modelId },
      };
    },
  });
}
