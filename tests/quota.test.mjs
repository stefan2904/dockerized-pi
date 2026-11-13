// Run with: node --test tests/quota.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Isolate the extension from real credentials, Pi UI, timers, and network.
const source = stripTypeScriptTypes(readFileSync(new URL("../pi/agent/extensions/quota.ts", import.meta.url), "utf8"))
  .replace(/^import .* from .*;\r?$/gm, "")
  .replace("export default function (", "function quotaExtension(");
const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account", chatgpt_plan_type: "team" },
  "https://api.openai.com/profile": { email: "test@example.invalid" },
})).toString("base64url")}.signature`;
const usage = {
  plan_type: "team",
  rate_limit: {
    primary_window: { used_percent: 92, limit_window_seconds: 18000, reset_after_seconds: 1000, reset_at: 1800000000 },
    secondary_window: { used_percent: 41, limit_window_seconds: 604800, reset_after_seconds: 400000, reset_at: 1800400000 },
  },
  credits: { unlimited: false, has_credits: true, balance: "12.50" },
};

function harness({ config = { access: "stale-token", accountId: "selected-account" }, access = token, data = usage, status = 200, fetchImpl } = {}) {
  const tools = new Map();
  const commands = new Map();
  const requests = [];
  const notifications = [];
  const widgets = [];
  const authLookups = [];
  const context = {
    modelRegistry: {
      async getApiKeyForProvider(provider) {
        authLookups.push(provider);
        return access;
      },
    },
    ui: {
      notify: (...args) => notifications.push(args),
      setWidget: (_name, factory) => {
        const theme = { fg: (_color, text) => text, bold: (text) => text };
        widgets.push(factory({}, theme).render(180).join("\n"));
      },
    },
  };
  const register = vm.runInNewContext(`${source}\nquotaExtension;`, {
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ "openai-codex": config }) },
    os: { homedir: () => "/test-home" },
    path,
    Type: { Object: () => ({}) },
    truncateToWidth: (text, width) => text.slice(0, width),
    visibleWidth: (text) => text.length,
    Buffer,
    AbortSignal,
    setTimeout: () => ({ unref() {} }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : Response.json(data, { status });
    },
  });
  register({
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
  });
  return {
    requests, notifications, widgets, authLookups,
    run: (signal) => tools.get("get_openai_codex_quota").execute("test", {}, signal, undefined, context),
    command: () => commands.get("quota").handler("", context),
  };
}

test("uses one model-independent usage request with resolved credentials and selected account", async () => {
  const h = harness();
  const result = await h.run();
  assert.ok(!result.isError);
  assert.deepEqual(h.authLookups, ["openai-codex"]);
  assert.equal(h.requests.length, 1);
  const { url, options } = h.requests[0];
  assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(options.method ?? "GET", "GET");
  assert.equal(options.body, undefined);
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  assert.equal(options.headers["chatgpt-account-id"], "selected-account");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.details.quota.planType, "team");
  assert.equal(result.details.quota.primary.usedPercent, 92);
  assert.equal(result.details.quota.primary.windowMinutes, 300);
  assert.equal(result.details.quota.primary.resetAt, 1800000000);
  assert.equal(result.details.quota.primary.resetAfterSeconds, 1000);
  assert.equal(result.details.quota.secondary.usedPercent, 41);
  assert.equal(result.details.quota.secondary.windowMinutes, 10080);
  assert.equal(result.details.quota.creditsBalance, 12.5);
  assert.equal(result.details.emailFromToken, "test@example.invalid");
  assert.equal(result.details.planFromToken, "team");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("falls back to the refreshed JWT for the account id", async () => {
  const h = harness({ config: { access: "stale-token" } });
  const result = await h.run();
  assert.ok(!result.isError);
  assert.equal(h.requests[0].options.headers["chatgpt-account-id"], "jwt-account");
});

test("handles null rate limits and null credits without inventing zero balances", async () => {
  const result = await harness({ data: { plan_type: "pro", rate_limit: null, credits: null } }).run();
  assert.ok(!result.isError);
  assert.equal(result.details.quota.primary, undefined);
  assert.equal(result.details.quota.secondary, undefined);
  assert.equal(result.details.quota.creditsBalance, undefined);
});

test("preserves zero usage, exhausted usage, and zero credit balance", async () => {
  const data = structuredClone(usage);
  data.rate_limit.primary_window.used_percent = 0;
  data.rate_limit.secondary_window.used_percent = 100;
  data.credits.balance = "0";
  const result = await harness({ data }).run();
  assert.equal(result.details.quota.primary.usedPercent, 0);
  assert.equal(result.details.quota.secondary.usedPercent, 100);
  assert.equal(result.details.quota.creditsBalance, 0);
});

test("invalid numeric values stay unavailable instead of becoming zero", async () => {
  const data = structuredClone(usage);
  data.rate_limit.primary_window.used_percent = null;
  data.rate_limit.secondary_window.used_percent = "not-a-number";
  data.credits.balance = " ";
  const result = await harness({ data }).run();
  assert.equal(result.details.quota.primary.usedPercent, undefined);
  assert.equal(result.details.quota.secondary.usedPercent, undefined);
  assert.equal(result.details.quota.creditsBalance, undefined);
});

for (const status of [401, 429, 500]) {
  test(`reports HTTP ${status} without falling back to inference requests`, async () => {
    const h = harness({ status });
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(String(status)));
    if (status === 401) assert.match(result.content[0].text, /\/login/);
    assert.equal(h.requests.length, 1);
  });
}

test("unresolved credentials fail before any network request", async () => {
  const h = harness({ access: "" });
  const result = await h.run();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /credentials.*\/login/);
  assert.equal(h.requests.length, 0);
});

test("reports unexpected usage response shapes", async () => {
  const result = await harness({ data: {} }).run();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /missing rate_limit/);
});

test("passes cancellation to the usage request", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({ fetchImpl: async (_url, options) => options.signal.throwIfAborted() });
  const result = await h.run(controller.signal);
  assert.equal(result.isError, true);
  assert.ok(h.requests[0].options.signal.aborted);
});

test("/quota renders remaining percentages using the same usage endpoint", async () => {
  const h = harness();
  await h.command();
  assert.deepEqual(h.authLookups, ["openai-codex"]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.widgets.length, 1);
  assert.match(h.widgets[0], /codex_primary.*8\.0% rem/);
  assert.match(h.widgets[0], /codex_seconda.*59\.0% rem/);
  assert.match(h.widgets[0], /credits.*12\.50/);
  assert.ok(!h.widgets[0].includes("n/a"));
});
