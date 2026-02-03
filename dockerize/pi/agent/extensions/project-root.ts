import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const updateStatus = (ui: any) => {
    const root = process.env.PI_PROJECT_ROOT;
    if (root) {
      // Use muted color to blend in with the footer
      ui.setStatus("project-root", ui.theme.fg("muted", `[${root}]`));
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      updateStatus(ctx.ui);
    }
  });

  // Ensure it's set if the extension is hot-reloaded
  if (pi.ui && (pi as any).ctx?.hasUI) {
     updateStatus((pi as any).ctx.ui);
  }
}
