import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-account";
const STORE_FILE = "codex-account-switcher.json";

type OpenAICodexCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

type StoredAccount = {
  label: string;
  email?: string;
  accountId?: string;
  access: string;
  refresh: string;
  expires: number;
  updatedAt: number;
};

type Store = {
  active?: string;
  accounts: Record<string, StoredAccount>;
};

type AuthFile = Record<string, unknown>;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return path.join(getAgentDir(), "auth.json");
}

function getStorePath(): string {
  return path.join(getAgentDir(), STORE_FILE);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function loadStore(): Promise<Store> {
  const store = await readJsonFile<Store>(getStorePath(), { accounts: {} });
  if (!store.accounts || typeof store.accounts !== "object") {
    store.accounts = {};
  }
  return store;
}

async function saveStore(store: Store): Promise<void> {
  await writeJsonFile(getStorePath(), store);
}

async function loadAuth(): Promise<AuthFile> {
  return readJsonFile<AuthFile>(getAuthPath(), {});
}

async function saveAuth(auth: AuthFile): Promise<void> {
  await writeJsonFile(getAuthPath(), auth);
}

function asCodexCredential(value: unknown): OpenAICodexCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<OpenAICodexCredential>;
  if (entry.type !== "oauth") return undefined;
  if (typeof entry.access !== "string" || !entry.access) return undefined;
  if (typeof entry.refresh !== "string" || !entry.refresh) return undefined;
  if (typeof entry.expires !== "number") return undefined;
  return {
    type: "oauth",
    access: entry.access,
    refresh: entry.refresh,
    expires: entry.expires,
    ...(typeof entry.accountId === "string" && entry.accountId ? { accountId: entry.accountId } : {}),
  };
}

async function loadCurrentCodexCredential(): Promise<OpenAICodexCredential | undefined> {
  const auth = await loadAuth();
  return asCodexCredential(auth[PROVIDER]);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function getEmailFromAccessToken(access: string): string | undefined {
  const payload = decodeJwtPayload(access);
  const profile = payload?.["https://api.openai.com/profile"];
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    const email = (profile as Record<string, unknown>).email;
    if (typeof email === "string" && email.trim()) return email.trim();
  }
  const email = payload?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

function makeDefaultLabel(credential: OpenAICodexCredential): string {
  const email = getEmailFromAccessToken(credential.access);
  if (email) return email;
  if (credential.accountId) return `codex-${credential.accountId.slice(0, 8)}`;
  return "codex-account";
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function accountFromCredential(label: string, credential: OpenAICodexCredential): StoredAccount {
  return {
    label,
    email: getEmailFromAccessToken(credential.access),
    accountId: credential.accountId,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    updatedAt: Date.now(),
  };
}

function credentialFromAccount(account: StoredAccount): OpenAICodexCredential {
  return {
    type: "oauth",
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    ...(account.accountId ? { accountId: account.accountId } : {}),
  };
}

function findMatchingAccountLabel(store: Store, credential: OpenAICodexCredential): string | undefined {
  for (const [label, account] of Object.entries(store.accounts)) {
    if (credential.accountId && account.accountId === credential.accountId) return label;
  }
  for (const [label, account] of Object.entries(store.accounts)) {
    if (account.refresh === credential.refresh) return label;
  }
  return undefined;
}

async function syncCurrentCredential(store: Store): Promise<string | undefined> {
  const current = await loadCurrentCodexCredential();
  if (!current) return undefined;
  const label = findMatchingAccountLabel(store, current);
  if (!label) return undefined;
  store.accounts[label] = accountFromCredential(label, current);
  store.active = label;
  return label;
}

function formatExpires(expires: number): string {
  const delta = expires - Date.now();
  if (delta <= 0) return "expired";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 90) return `expires in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires in ${Math.round(hours / 24)}d`;
}

function describeAccount(account: StoredAccount): string {
  const identity = account.email || account.accountId || "unknown";
  return `${account.label} (${identity}, ${formatExpires(account.expires)})`;
}

function parseArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of args.matchAll(re)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

function getAccountCompletions(prefix: string): AutocompleteItem[] | null {
  const partial = prefix.trim().split(/\s+/).pop() ?? "";
  // Autocomplete is synchronous; avoid async file reads here.
  try {
    const raw = readFileSync(getStorePath(), "utf8");
    const store = JSON.parse(raw) as Store;
    const items = Object.keys(store.accounts || {})
      .filter((label) => label.startsWith(partial))
      .map((label) => ({ value: label, label }));
    return items.length ? items : null;
  } catch {
    return null;
  }
}

function refreshPiAuth(ctx: ExtensionCommandContext): void {
  ctx.modelRegistry.authStorage.reload();
  ctx.modelRegistry.refresh();
}

async function updateStatus(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">, store?: Store): Promise<void> {
  const loaded = store ?? (await loadStore());
  let label = loaded.active;
  const current = await loadCurrentCodexCredential();
  if (current) {
    label = findMatchingAccountLabel(loaded, current) ?? label;
  }
  ctx.ui.setStatus(STATUS_KEY, label ? `codex: ${label}` : undefined);
}

async function promptForAccount(ctx: ExtensionCommandContext, store: Store, title = "Select Codex account:"): Promise<string | undefined> {
  const labels = Object.keys(store.accounts).sort((a, b) => a.localeCompare(b));
  if (labels.length === 0) return undefined;
  const display = labels.map((label) => describeAccount(store.accounts[label]));
  const choice = await ctx.ui.select(title, display);
  if (!choice) return undefined;
  const index = display.indexOf(choice);
  return index >= 0 ? labels[index] : undefined;
}

async function saveCurrent(ctx: ExtensionCommandContext, rawLabel?: string): Promise<void> {
  const current = await loadCurrentCodexCredential();
  if (!current) {
    ctx.ui.notify("No Pi openai-codex OAuth credential found. Run /login openai-codex first.", "error");
    return;
  }

  let label = normalizeLabel(rawLabel || "");
  if (!label) {
    const suggested = makeDefaultLabel(current);
    if (ctx.hasUI) {
      label = normalizeLabel((await ctx.ui.input("Save current Codex login as:", suggested)) || "");
    } else {
      label = suggested;
    }
  }
  if (!label) {
    ctx.ui.notify("Save cancelled.", "warning");
    return;
  }

  const store = await loadStore();
  if (store.accounts[label] && ctx.hasUI) {
    const ok = await ctx.ui.confirm("Overwrite Codex account?", `Replace saved account "${label}" with the current login?`);
    if (!ok) {
      ctx.ui.notify("Save cancelled.", "warning");
      return;
    }
  }

  store.accounts[label] = accountFromCredential(label, current);
  store.active = label;
  await saveStore(store);
  await updateStatus(ctx, store);
  ctx.ui.notify(`Saved current Codex login as "${label}".`, "info");
}

async function switchAccount(ctx: ExtensionCommandContext, rawLabel?: string): Promise<void> {
  const store = await loadStore();
  await syncCurrentCredential(store);

  let label = normalizeLabel(rawLabel || "");
  if (!label) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /codex-account switch <name>", "error");
      return;
    }
    label = (await promptForAccount(ctx, store)) || "";
  }

  const account = store.accounts[label];
  if (!account) {
    ctx.ui.notify(`No saved Codex account named "${label}".`, "error");
    return;
  }

  await saveStore(store); // Persist synced token before switching away.
  const auth = await loadAuth();
  auth[PROVIDER] = credentialFromAccount(account);
  await saveAuth(auth);
  store.active = label;
  await saveStore(store);
  refreshPiAuth(ctx);
  await updateStatus(ctx, store);
  ctx.ui.notify(`Switched Codex account to "${label}".`, "info");
}

async function listAccounts(ctx: ExtensionCommandContext): Promise<void> {
  const store = await loadStore();
  await syncCurrentCredential(store);
  await saveStore(store);
  await updateStatus(ctx, store);

  const labels = Object.keys(store.accounts).sort((a, b) => a.localeCompare(b));
  if (labels.length === 0) {
    ctx.ui.notify("No saved Codex accounts. Run /codex-account save <name> after /login openai-codex.", "info");
    return;
  }

  const active = store.active || "none";
  const lines = [`Active: ${active}`, "", ...labels.map((label) => {
    const account = store.accounts[label];
    const marker = label === active ? "*" : "-";
    const identity = account.email || account.accountId || "unknown";
    return `${marker} ${label} — ${identity} — ${formatExpires(account.expires)}`;
  })];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function deleteAccount(ctx: ExtensionCommandContext, rawLabel?: string): Promise<void> {
  const store = await loadStore();
  let label = normalizeLabel(rawLabel || "");
  if (!label) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /codex-account delete <name>", "error");
      return;
    }
    label = (await promptForAccount(ctx, store, "Delete Codex account:")) || "";
  }
  if (!store.accounts[label]) {
    ctx.ui.notify(`No saved Codex account named "${label}".`, "error");
    return;
  }
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Delete Codex account?", `Delete saved account "${label}"? This does not log out Pi if it is currently active.`);
    if (!ok) {
      ctx.ui.notify("Delete cancelled.", "warning");
      return;
    }
  }
  delete store.accounts[label];
  if (store.active === label) store.active = undefined;
  await saveStore(store);
  await updateStatus(ctx, store);
  ctx.ui.notify(`Deleted saved Codex account "${label}".`, "info");
}

async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    await listAccounts(ctx);
    return;
  }
  const choice = await ctx.ui.select("Codex accounts", [
    "Switch account",
    "Save current login",
    "List accounts",
    "Delete account",
  ]);
  if (choice === "Switch account") await switchAccount(ctx);
  if (choice === "Save current login") await saveCurrent(ctx);
  if (choice === "List accounts") await listAccounts(ctx);
  if (choice === "Delete account") await deleteAccount(ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await updateStatus(ctx).catch(() => undefined);
  });

  pi.registerCommand("codex-account", {
    description: "Save, list, delete, and switch Pi openai-codex account snapshots",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const words = prefix.trimStart().split(/\s+/);
      const command = words[0] || "";
      if (words.length <= 1) {
        return ["save", "switch", "list", "delete"].filter((x) => x.startsWith(command)).map((x) => ({ value: x, label: x }));
      }
      if (command === "switch" || command === "delete") return getAccountCompletions(prefix);
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [command, ...rest] = parseArgs(args || "");
      const label = normalizeLabel(rest.join(" "));
      if (!command) return showMenu(ctx);
      if (command === "save") return saveCurrent(ctx, label);
      if (command === "switch" || command === "use") return switchAccount(ctx, label);
      if (command === "list" || command === "show") return listAccounts(ctx);
      if (command === "delete" || command === "remove" || command === "rm") return deleteAccount(ctx, label);
      if (command === "help") {
        ctx.ui.notify("Usage: /codex-account [save [name]|switch [name]|list|delete [name]]", "info");
        return;
      }
      ctx.ui.notify(`Unknown codex-account command "${command}". Try /codex-account help.`, "error");
    },
  });

  pi.registerCommand("codex-switch", {
    description: "Open Codex account switcher",
    getArgumentCompletions: getAccountCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => switchAccount(ctx, normalizeLabel(args || "")),
  });
}
