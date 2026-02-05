import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const updateStatus = (ui: any) => {
    const root = process.env.PI_PROJECT_ROOT;
    const hostname = process.env.PI_HOST_HOSTNAME;
    const mode = process.env.PI_MOUNT_MODE;
    let status = "";
    if (root) status += root;
    if (hostname) status += ` @ ${hostname}`;
    if (mode === "ro") status += " (RO)";

    if (status) {
      // Use muted color to blend in with the footer
      ui.setStatus("dockerized-project-info", ui.theme.fg("muted", `[${status}]`));
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
