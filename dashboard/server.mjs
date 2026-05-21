import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const controlPlaneDir = resolve(repoRoot, "control-plane");
const dashboardPath = resolve(here, "index.html");

const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "9090");
const botMetricsPort = Number(process.env.BOT_METRICS_PORT ?? "9091");
const tmuxSession = process.env.BOT_TMUX_SESSION ?? "bot";
const botCommand = process.env.BOT_COMMAND ?? `METRICS_PORT=${botMetricsPort} node dist/index.js`;
const botBaseUrl = `http://127.0.0.1:${botMetricsPort}`;

const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "access-control-allow-origin": "*",
};

createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/";

  if (request.method === "OPTIONS") {
    response.writeHead(204, jsonHeaders);
    response.end();
    return;
  }

  if (request.method === "GET" && (path === "/" || path === "/dashboard")) {
    void readFile(dashboardPath, "utf8").then((html) => {
      response.writeHead(200, htmlHeaders);
      response.end(html);
    }).catch((error) => {
      respondJson(response, 500, { ok: false, error: String(error) });
    });
    return;
  }

  if (path === "/supervisor/status" && request.method === "GET") {
    void supervisorStatus().then((status) => respondJson(response, 200, status));
    return;
  }

  if (path === "/supervisor/start" && request.method === "POST") {
    void startBot().then((result) => respondJson(response, 202, result)).catch((error) => {
      respondJson(response, 500, { ok: false, error: error.message });
    });
    return;
  }

  if (path === "/supervisor/stop" && request.method === "POST") {
    void stopBot().then((result) => respondJson(response, 202, result)).catch((error) => {
      respondJson(response, 500, { ok: false, error: error.message });
    });
    return;
  }

  if (path === "/supervisor/restart" && request.method === "POST") {
    void stopBot().catch(() => undefined).then(() => startBot()).then((result) => respondJson(response, 202, result)).catch((error) => {
      respondJson(response, 500, { ok: false, error: error.message });
    });
    return;
  }

  if (path === "/supervisor/detach" && request.method === "POST") {
    void tmux(["detach-client", "-s", tmuxSession]).then(() => respondJson(response, 202, { ok: true })).catch((error) => {
      respondJson(response, 500, { ok: false, error: error.message });
    });
    return;
  }

  if (path === "/supervisor/attach-command" && request.method === "GET") {
    respondJson(response, 200, {
      ok: true,
      command: `tmux attach -t ${tmuxSession}`,
      note: "Run this inside SSH. A browser cannot attach to an interactive tmux terminal.",
    });
    return;
  }

  if (isBotApiPath(path)) {
    void proxyToBot(request, response, path);
    return;
  }

  respondJson(response, 404, { ok: false, error: "not found" });
}).listen(dashboardPort, "127.0.0.1", () => {
  console.log(JSON.stringify({
    level: "INFO",
    scope: "dashboard-supervisor",
    message: "dashboard supervisor listening",
    dashboardPort,
    botMetricsPort,
    tmuxSession,
  }));
});

function isBotApiPath(path) {
  return ["/status", "/metrics", "/settings", "/healthz", "/pause", "/resume"].includes(path);
}

async function proxyToBot(request, response, path) {
  const body = request.method === "POST" ? await readBody(request) : undefined;
  const botResponse = await fetch(`${botBaseUrl}${path}`, {
    method: request.method,
    headers: body ? { "content-type": request.headers["content-type"] ?? "application/json" } : undefined,
    body,
  });
  const text = await botResponse.text();
  response.writeHead(botResponse.status, {
    "content-type": botResponse.headers.get("content-type") ?? "application/json",
    "access-control-allow-origin": "*",
  });
  response.end(text);
}

async function supervisorStatus() {
  const tmuxInstalled = await commandOk("tmux", ["-V"]);
  const sessionExists = tmuxInstalled ? await hasSession() : false;
  const botHealthy = await botHealth();
  return {
    ok: true,
    tmuxInstalled,
    sessionExists,
    tmuxSession,
    attachCommand: `tmux attach -t ${tmuxSession}`,
    detachCommand: `tmux detach-client -s ${tmuxSession}`,
    dashboardPort,
    botMetricsPort,
    botBaseUrl,
    botCommand,
    controlPlaneDir,
    botHealthy,
  };
}

async function startBot() {
  if (!(await commandOk("tmux", ["-V"]))) {
    throw new Error("tmux is not installed");
  }
  if (await hasSession()) {
    return { ok: true, alreadyRunning: true, ...(await supervisorStatus()) };
  }
  await tmux(["new-session", "-d", "-s", tmuxSession, "-c", controlPlaneDir, "bash", "-lc", botCommand]);
  return { ok: true, started: true, ...(await supervisorStatus()) };
}

async function stopBot() {
  if (!(await hasSession())) {
    return { ok: true, alreadyStopped: true, ...(await supervisorStatus()) };
  }
  await tmux(["send-keys", "-t", tmuxSession, "C-c"]);
  await wait(750);
  if (await hasSession()) {
    await tmux(["kill-session", "-t", tmuxSession]);
  }
  return { ok: true, stopped: true, ...(await supervisorStatus()) };
}

async function hasSession() {
  return commandOk("tmux", ["has-session", "-t", tmuxSession]);
}

async function botHealth() {
  try {
    const response = await fetch(`${botBaseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function commandOk(command, args) {
  try {
    await exec(command, args);
    return true;
  } catch {
    return false;
  }
}

function tmux(args) {
  return exec("tmux", args);
}

function exec(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `: ${stderr.trim()}` : ""}`;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
  });
}

function respondJson(response, status, payload) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(payload));
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
