// Probes a local codex app-server: initialize, account/read, model/list, thread/start (no turn).
import { spawn } from "node:child_process";
const server = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = ""; const pending = new Map(); let nextId = 1;
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else console.log("notify", message.method);
  }
});
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); server.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const started = Date.now();
const show = (label, value) => console.log(label, `${Date.now() - started}ms`, JSON.stringify(value).slice(0, 400));
show("initialize", await request("initialize", { clientInfo: { name: "margin_probe", title: "Margin probe", version: "0.0.0" }, capabilities: null }));
server.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
show("account/read", await request("account/read", {}));
const models = await request("model/list", {});
show("model/list", models.result?.data?.map((model) => model.id) ?? models);
show("thread/start", await request("thread/start", { ephemeral: true, sandbox: "read-only", approvalPolicy: "never", developerInstructions: "probe" }));
server.kill();
