import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

async function runTest() {
  const settingsPath = join(homedir(), ".pi/agent/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const models = (settings.enabledModels || []);

  console.log(`# Model Connectivity Test\n`);
  console.log(`| Model | Status | Response |`);
  console.log(`| :--- | :--- | :--- |`);

  for (const model of models) {
    try {
      const response = await callPi(model, "hello");
      const status = response.success ? "✅ OK" : "❌ Fail";
      const reply = response.output.replace(/\n/g, " ").slice(0, 100) + (response.output.length > 100 ? "..." : "");
      console.log(`| ${model} | ${status} | ${reply} |`);
    } catch (err) {
      console.log(`| ${model} | ❌ Error | ${err instanceof Error ? err.message : String(err)} |`);
    }
  }
}

function callPi(model: string, prompt: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--model", model, "-p", prompt]);
    let output = "";
    let error = "";

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ success: false, output: "Timeout (5s)" });
    }, 5000);

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      error += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ success: true, output: output.trim() });
      } else {
        resolve({ success: false, output: error.trim() || `Exit code ${code}` });
      }
    });
  });
}

runTest().catch(console.error);
