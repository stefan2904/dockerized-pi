import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { get } from "node:https";
import { hostname, networkInterfaces } from "node:os";

type IpFamily = 4 | 6;
type PublicIp = { ip: string; hostname?: string };

function fetchPublicIp(family: IpFamily): Promise<PublicIp> {
  return new Promise((resolve, reject) => {
    const request = get(
      "https://ifconfig.co/json",
      {
        family,
        headers: { Accept: "application/json", "User-Agent": "pi-myip-extension" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
            const data = JSON.parse(body) as { ip?: unknown; hostname?: unknown };
            if (typeof data.ip !== "string") throw new Error("invalid response");
            resolve({
              ip: data.ip,
              hostname: typeof data.hostname === "string" ? data.hostname : undefined,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.setTimeout(5000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("myip", {
    description: "Show public and internal IP addresses and hostnames",
    handler: async (_args, ctx) => {
      const [public4, public6] = await Promise.allSettled([
        fetchPublicIp(4),
        fetchPublicIp(6),
      ]);

      const interfaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
      const internal4 = interfaces.filter((entry) => !entry.internal && entry.family === "IPv4");
      const internal6 = interfaces.filter((entry) => !entry.internal && entry.family === "IPv6");
      const formatPublic = (result: PromiseSettledResult<PublicIp>) =>
        result.status === "fulfilled"
          ? `${result.value.ip}${result.value.hostname ? ` (${result.value.hostname})` : ""}`
          : "unavailable";
      const formatInternal = (addresses: typeof internal4) =>
        addresses.length ? addresses.map((entry) => entry.address).join(", ") : "unavailable";

      const output = [
        `Public IPv4: ${formatPublic(public4)}`,
        `Public IPv6: ${formatPublic(public6)}`,
        `Internal hostname: ${hostname()}`,
        `Internal IPv4: ${formatInternal(internal4)}`,
        `Internal IPv6: ${formatInternal(internal6)}`,
      ].join("\n");

      if (ctx.hasUI) ctx.ui.notify(output, "info");
      else console.log(output);
    },
  });
}
