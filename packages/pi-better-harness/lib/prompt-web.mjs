import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { managerAction } from "./prompt-manager.mjs";

async function listen(dispatch, ui = false) {
  const token = randomBytes(32).toString("hex");
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if ("http://" + req.headers.host !== origin) { res.writeHead(403).end(); return; }
    const assets = { "/": ["prompt.html", "text/html"], "/manager.js": ["prompt-ui.mjs", "text/javascript"],
      "/prompt-report.mjs": ["prompt-report.mjs", "text/javascript"], "/manager.css": ["prompt.css", "text/css"] };
    if (ui && req.method === "GET" && Object.hasOwn(assets, req.url)) {
      const [file, type] = assets[req.url];
      res.writeHead(200, { "content-type": type + "; charset=utf-8" }).end(readFileSync(new URL(file, import.meta.url)));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api" || req.headers.authorization !== "Bearer " + token ||
        req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
      res.writeHead(403).end(); return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw Error("Request exceeds 8 MiB");
        chunks.push(chunk);
      }
      const result = await dispatch(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  origin = "http://127.0.0.1:" + port;
  return { port, token, url: origin + "/#" + token, close: () => { server.close(); server.closeAllConnections(); } };
}

const sessions = dir => join(dir, "harness-prompt-revisions", "connections");
export async function shareSession(dir, name, session) {
  const endpoint = await listen(args => args.action === "describe" ? session.describe() : session.run(args));
  const id = randomUUID();
  const path = join(sessions(dir), id + ".json");
  try {
    mkdirSync(sessions(dir), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ name, port: endpoint.port, token: endpoint.token }), { flag: "wx", mode: 0o600 });
  } catch (error) { endpoint.close(); throw error; }
  return { close() { endpoint.close(); rmSync(path, { force: true }); } };
}

function connections(dir) {
  let files;
  try { files = readdirSync(sessions(dir)); } catch (e) { if (e.code !== "ENOENT") throw e; return []; }
  return files.filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).flatMap(file => {
    try { return [{ id: file.slice(0, -5), ...JSON.parse(readFileSync(join(sessions(dir), file), "utf8")) }]; }
    catch (e) { if (e.code !== "ENOENT") throw e; return []; }
  });
}
export async function startPromptWeb(dir) {
  return listen(async args => {
    const list = connections(dir);
    const selected = list.find(s => s.id === args.session);
    const send = async request => {
      if (!selected) throw Error("Pi session disconnected. Reconnect from Prompt manager in Pi.");
      const origin = "http://127.0.0.1:" + Number(selected.port);
      let response;
      try { response = await fetch(origin + "/api", { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", origin, authorization: "Bearer " + selected.token }, body: JSON.stringify(request) }); }
      catch { throw Error("Pi session closed. Reconnect from Prompt manager in Pi."); }
      if (response.status === 403) throw Error("Pi session connection expired.");
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      return data.result;
    };
    let session = args.session ? { describe: () => send({ action: "describe" }), run: send } : null;
    if (args.action !== "state") return managerAction(dir, args, session);
    let problem;
    if (session) {
      try { const description = await session.describe(); session = { describe: () => description, run: send }; }
      catch (e) { problem = e.message; session = null; }
    }
    return { ...await managerAction(dir, args, session), problem, connections: list.map(({ id, name }) => ({ id, name })) };
  }, true);
}

export async function launchPromptWeb(dir, stdout) {
  const web = await startPromptWeb(dir);
  stdout.write(web.url + "\n");
  if (process.env.BROWSER !== "none") {
    const [cmd, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler"] : ["xdg-open"];
    const child = spawn(cmd, [...args, web.url], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); child.unref();
  }
  return 0;
}
