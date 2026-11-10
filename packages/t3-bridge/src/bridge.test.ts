import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { configSchema, parseDelivery } from "./config.ts";
import { Store } from "./store.ts";
import { Bridge } from "./bridge.ts";
import { T3 } from "./t3.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function config() {
  return configSchema.parse({
    emberOrigin: "http://127.0.0.1",
    botKey: "bot-secret",
    webhookSecret: "s".repeat(40),
    allowedUsers: ["u"],
    allowedRooms: ["r"],
    mcpUrl: "http://127.0.0.1/mcp",
    environmentId: "env",
    projectId: "p",
    t3Origin: "https://t3.example",
    dataDir: mkdtempSync(`${tmpdir()}/ember-t3-`),
  });
}
function payload(id = "m", parent?: string) {
  return {
    user: { id: "u", name: "User" },
    room: { id: "r", name: "Room", path: `/rooms/r/bot-secret/messages${parent ? `?thread=${parent}` : ""}` },
    message: { id, path: "/unused", body: { plain: "hello", html: "<b>hello</b>" } },
  };
}

test("HTTP ingress authenticates, validates, deduplicates and rejects without submission", async () => {
  const c = config();
  const store = new Store(c);
  let submits = 0;
  const bridge = new Bridge(c, store, {
    submit: async () => {
      submits++;
      return { threadId: "t", runId: "run", link: null };
    },
    observe: async () => ({ done: false, text: "", status: "running" }),
  });
  const server = bridge.server();
  const base = await listen(server);
  const post = (path: string, value: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await post("/webhook/wrong", payload())).status, 404);
    for (const value of [
      { ...payload(), user: { id: "evil", name: "x" } },
      { ...payload(), room: { ...payload().room, path: "https://evil.example/rooms/r/bot-secret/messages" } },
      { ...payload(), message: { ...payload().message, body: { plain: "x".repeat(70000), html: null } } },
    ])
      assert.equal((await post(`/webhook/${c.webhookSecret}`, value)).status, 400);
    assert.equal(submits, 0);
    assert.equal(store.jobs().length, 0);
    assert.equal((await post(`/webhook/${c.webhookSecret}`, payload("orphan", "missing"))).status, 409);
    assert.equal((await post(`/webhook/${c.webhookSecret}`, payload())).status, 202);
    assert.equal((await post(`/webhook/${c.webhookSecret}`, payload())).status, 202);
    const changed = payload();
    changed.message.body.plain = "different";
    assert.equal((await post(`/webhook/${c.webhookSecret}`, changed)).status, 400);
    assert.equal(store.jobs().length, 1);
    assert.equal(submits, 0);
    await bridge.tick();
    assert.equal(submits, 1);
    await bridge.tick();
    assert.equal(store.jobs()[0]?.state.kind, "running");
    assert.equal((await fetch(`${base}/status/${c.webhookSecret}`)).status, 200);
  } finally {
    await close(server);
    store.close();
    rmSync(c.dataDir, { recursive: true });
  }
});

test("long runs, restart observation, callback escaping and same-conversation followups", async () => {
  const c = config();
  const received: string[] = [];
  const callback = createServer(async (req, res) => {
    assert.equal(req.url, "/rooms/r/bot-secret/messages?thread=m");
    let body = "";
    for await (const part of req) body += part;
    received.push(body);
    res.writeHead(201).end();
  });
  c.emberOrigin = await listen(callback);
  let store = new Store(c);
  let done = false;
  const previous: (string | undefined)[] = [];
  const t3 = {
    submit: async (_key: string, _text: string, target?: { threadId: string }) => {
      previous.push(target?.threadId);
      return { threadId: "t", runId: `run${previous.length}`, link: "https://t3.example/thread" };
    },
    observe: async () => ({ done, text: "<script>&hi" + "x".repeat(16000), status: done ? "completed" : "running" }),
  };
  try {
    store.enqueue(parseDelivery(payload(), c));
    store.enqueue(parseDelivery(payload("next", "m"), c));
    await new Bridge(c, store, t3).tick();
    store.close();
    store = new Store(c);
    const bridge = new Bridge(c, store, t3);
    await bridge.tick();
    assert.equal(previous.length, 1);
    assert.equal(received.length, 0);
    done = true;
    await bridge.tick();
    assert.equal(store.jobs()[0]?.state.kind, "reply-pending");
    store.close();
    store = new Store(c);
    const restarted = new Bridge(c, store, t3);
    await restarted.tick();
    assert.equal(received.length, 1);
    assert(received[0]?.includes("&lt;script&gt;&amp;hi"));
    assert(!received[0]?.includes("<script>"));
    const pending = store.jobs()[0];
    assert(pending?.state.kind === "completed");
    assert(received[0]?.includes("[Truncated. Open T3"));
    assert(
      (received[0]
        ?.replaceAll("<br>", "\n")
        .replace(/<[^>]*>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&").length ?? Infinity) <= 10000,
    );
    await restarted.tick();
    assert.deepEqual(previous, [undefined, "t"]);
    assert.equal(store.jobs()[0]?.state.kind, "completed");
  } finally {
    store.close();
    await close(callback);
    rmSync(c.dataDir, { recursive: true });
  }
});

test("unknown submissions and interrupted delivery never replay and block followups", async () => {
  const c = config();
  let store = new Store(c);
  let calls = 0;
  const t3 = {
    submit: async () => {
      calls++;
      throw new Error("ack lost");
    },
    observe: async () => {
      throw new Error();
    },
  };
  try {
    store.enqueue(parseDelivery(payload(), c));
    store.enqueue(parseDelivery(payload("next", "m"), c));
    await new Bridge(c, store, t3).tick();
    await new Bridge(c, store, t3).tick();
    assert.equal(calls, 1);
    store.close();
    store = new Store(c);
    await new Bridge(c, store, t3).tick();
    assert.equal(calls, 1);
    assert.equal(store.jobs()[0]?.state.kind, "unknown");
    store.save("r:m", { kind: "delivering", target: { threadId: "t", runId: "run", link: null }, reply: "pending" });
    store.close();
    store = new Store(c);
    assert.equal(store.jobs()[0]?.state.kind, "unknown");
  } finally {
    store.close();
    rmSync(c.dataDir, { recursive: true });
  }
});

test("real MCP HTTP serialization validates environment, modes, queued followups and exact local output", async () => {
  const c = config();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let environment = "env";
  const http = createServer(async (req, res) => {
    const mcp = new McpServer({ name: "fixture", version: "1" });
    const result = (data: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    });
    mcp.registerTool("t3_environment_read", { inputSchema: { environmentId: z.string() } }, async (args) => {
      calls.push({ name: "env", args });
      return result({ environmentId: environment });
    });
    mcp.registerTool("t3_project_list", { inputSchema: { environmentId: z.string(), limit: z.number() } }, async () =>
      result({ projects: [{ id: "p", deletedAt: null }], nextCursor: null }),
    );
    mcp.registerTool(
      "t3_thread_launch",
      {
        inputSchema: {
          environmentId: z.string(),
          projectId: z.string(),
          clientRequestId: z.string(),
          runtimeMode: z.string(),
          workspaceStrategy: z.object({ type: z.string() }),
          title: z.string(),
          message: z.string(),
          interactionMode: z.string(),
        },
      },
      async (args) => {
        calls.push({ name: "launch", args });
        return result({ threadId: "t", runId: "run", projectId: "p", link: "https://evil.example/t" });
      },
    );
    mcp.registerTool(
      "t3_thread_send",
      {
        inputSchema: {
          environmentId: z.string(),
          threadId: z.string(),
          clientRequestId: z.string(),
          message: z.string(),
          mode: z.string(),
        },
      },
      async (args) => {
        calls.push({ name: "send", args });
        return result({ threadId: "t", runId: "run2", delivery: "queued" });
      },
    );
    mcp.registerTool(
      "t3_thread_read",
      {
        inputSchema: {
          environmentId: z.string(),
          threadId: z.string(),
          view: z.string(),
          limit: z.number(),
          runLimit: z.number(),
          maxCharsPerItem: z.number(),
          afterPosition: z.number().optional(),
        },
      },
      async () =>
        result({
          thread: {
            threadId: "t",
            projectId: "p",
            parentThreadId: null,
            latestRunId: "run",
            activeRunId: null,
            pendingRequestCount: 0,
            settled: true,
            runtimeMode: "approval-required",
          },
          recentRuns: [{ runId: "run", status: "completed" }],
          items: [
            {
              itemId: "i",
              sourceThreadId: "t",
              runId: "run",
              createdBy: "agent",
              visibility: "local",
              type: "assistant_message",
              text: "local output",
              textTruncated: false,
            },
            {
              itemId: "bad",
              sourceThreadId: "child",
              runId: "run",
              createdBy: "agent",
              visibility: "local",
              type: "assistant_message",
              text: "child secret",
              textTruncated: false,
            },
          ],
          hasMore: false,
          nextPosition: null,
        }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  c.mcpUrl = (await listen(http)) + "/mcp";
  try {
    const t3 = new T3(c);
    await t3.check();
    const target = await t3.submit("r:m", "hello");
    assert.equal(target.link, null);
    assert.equal(calls.find((c) => c.name === "launch")?.args.runtimeMode, "approval-required");
    assert.deepEqual(calls.find((c) => c.name === "launch")?.args.workspaceStrategy, { type: "worktree" });
    assert.equal((await t3.observe(target)).text, "local output");
    await t3.submit("r:next", "followup", target);
    assert.equal(calls.find((c) => c.name === "send")?.args.mode, "queue");
    const reservation = createServer();
    c.port = Number(new URL(await listen(reservation)).port);
    await close(reservation);
    const file = `${c.dataDir}/config.json`;
    writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
    const child = spawn(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, "serve", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Executable startup timed out")), 10000);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Executable exited ${code}`));
        });
        child.stdout.on("data", (data) => {
          if (String(data).includes("bridge listening")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      assert.equal((await fetch(`http://127.0.0.1:${c.port}/health`)).status, 200);
      const status = await fetch(`http://127.0.0.1:${c.port}/status/${c.webhookSecret}`);
      assert.deepEqual(await status.json(), []);
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
    environment = "wrong";
    const before = calls.filter((c) => c.name === "launch").length;
    await assert.rejects(t3.submit("bad", "bad"));
    assert.equal(calls.filter((c) => c.name === "launch").length, before);
    environment = "env";
    await assert.rejects(t3.observe({ ...target, runId: "missing" }));
  } finally {
    await close(http);
    rmSync(c.dataDir, { recursive: true });
  }
});

test("executable help and invalid configuration run without a T3 request", () => {
  const cli = new URL("./cli.ts", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const invalid = spawnSync(process.execPath, [cli.pathname, "serve", "/missing/config"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Bridge failed/);
});

test("OAuth performs discovery, registration, PKCE and validates callback state over HTTP", async () => {
  const { setupOAuth, OAuth } = await import("./oauth.ts");
  const { createHash } = await import("node:crypto");
  const c = config();
  const reserve = createServer();
  const redirectOrigin = await listen(reserve);
  c.oauthPort = Number(new URL(redirectOrigin).port);
  await close(reserve);
  let challenge = "";
  let tokenRequests = 0;
  let authorizationOrigin = "";
  const oauthServer = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.end(JSON.stringify({ resource: c.mcpUrl, authorization_servers: [authorizationOrigin] }));
      return;
    }
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.end(
        JSON.stringify({
          issuer: authorizationOrigin,
          authorization_endpoint: authorizationOrigin + "/authorize",
          token_endpoint: authorizationOrigin + "/token",
          registration_endpoint: authorizationOrigin + "/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    if (req.url === "/register") {
      res.writeHead(201).end(JSON.stringify({ ...JSON.parse(body), client_id: "fixture-client" }));
      return;
    }
    if (req.url === "/token") {
      const params = new URLSearchParams(body);
      tokenRequests++;
      assert.equal(params.get("code"), "fixture-code");
      assert.equal(
        createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url"),
        challenge,
      );
      res.end(
        JSON.stringify({
          access_token: "fixture-token",
          token_type: "Bearer",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      );
      return;
    }
    res.writeHead(404).end("{}");
  });
  authorizationOrigin = await listen(oauthServer);
  c.mcpUrl = authorizationOrigin + "/mcp";
  let callbacks: Promise<void> = Promise.resolve();
  try {
    await setupOAuth(c, (url) => {
      challenge = url.searchParams.get("code_challenge") ?? "";
      assert(challenge);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      callbacks = (async () => {
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", "invalid");
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        assert.equal((await fetch(callback)).status, 200);
      })();
    });
    await callbacks;
    assert.equal(tokenRequests, 1);
    assert.equal(new OAuth(c).tokens()?.access_token, "fixture-token");
    const other = { ...c, mcpUrl: authorizationOrigin + "/other" };
    assert.throws(() => new OAuth(other).tokens(), /endpoint/);
  } finally {
    await close(oauthServer);
    rmSync(c.dataDir, { recursive: true });
  }
});

test("observation errors remain visible and callback rejection preserves the T3 target without replay", async () => {
  const c = config();
  let posts = 0;
  const callback = createServer((_req, res) => {
    posts++;
    res.writeHead(401).end();
  });
  c.emberOrigin = await listen(callback);
  const store = new Store(c);
  const target = { threadId: "t", runId: "run", link: "https://t3.example/thread" };
  let disconnected = true;
  const bridge = new Bridge(c, store, {
    submit: async () => target,
    observe: async () => {
      if (disconnected) throw new Error("revoked");
      return { done: true, text: "result", status: "completed" };
    },
  });
  try {
    store.enqueue(parseDelivery(payload(), c));
    await bridge.tick();
    await bridge.tick();
    const running = store.jobs()[0]?.state;
    assert.equal(running?.kind, "running");
    assert(running?.kind === "running" && running.error?.includes("Cannot observe"));
    disconnected = false;
    await bridge.tick();
    await bridge.tick();
    await bridge.tick();
    assert.equal(posts, 1);
    const unknown = store.jobs()[0]?.state;
    assert(unknown?.kind === "unknown");
    assert.deepEqual(unknown.target, target);
  } finally {
    store.close();
    await close(callback);
    rmSync(c.dataDir, { recursive: true });
  }
});
