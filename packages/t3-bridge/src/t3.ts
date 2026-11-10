import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod/v4";
import { type Config, safeFetch } from "./config.ts";
import { OAuth } from "./oauth.ts";
import type { Target } from "./store.ts";

const id = z.string().min(1);
const status = z.enum([
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const accepted = z.object({ threadId: id, runId: id, link: z.string().nullish() });
const readSchema = z.object({
  thread: z.object({
    threadId: id,
    projectId: id,
    parentThreadId: id.nullable(),
    latestRunId: id.nullable(),
    activeRunId: id.nullable(),
    pendingRequestCount: z.number(),
    runtimeMode: z.string(),
  }),
  recentRuns: z.array(z.object({ runId: id, status })),
  items: z.array(
    z.object({
      itemId: id,
      sourceThreadId: id,
      runId: id.nullable(),
      createdBy: z.string().nullable(),
      visibility: z.string(),
      type: z.string(),
      text: z.string().nullable(),
      textTruncated: z.boolean(),
    }),
  ),
  hasMore: z.boolean(),
  nextPosition: z.number().nullable(),
});
export class T3 {
  private config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  private link(value: string | null | undefined, threadId: string) {
    if (!value || value.length > 2048) return null;
    try {
      const href = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
      const native = `t3-thread://v2/${this.config.environmentId}/${threadId}`;
      if (href.startsWith("t3-thread:")) return href === native && !/[?#\s<>]/.test(href) ? `<${href}>` : null;
      const url = new URL(href);
      return url.origin === this.config.t3Origin && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }
  async connected<T>(work: (client: Client) => Promise<T>) {
    const client = new Client({ name: "ember-t3-bridge", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
      authProvider: new OAuth(this.config),
      fetch: safeFetch,
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      await client.connect(transport, { timeout: 20000 });
      const environment = await this.call(client, "t3_environment_read", {}, z.object({ environmentId: id }));
      if (environment.environmentId !== this.config.environmentId) throw new Error("Environment mismatch");
      return await work(client);
    } finally {
      await client.close().catch(() => {});
    }
  }
  private async call<T>(client: Client, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
    const result = await client.callTool(
      { name, arguments: { ...args, environmentId: this.config.environmentId } },
      undefined,
      { timeout: 20000 },
    );
    if (result.isError) throw new Error("T3 tool rejected operation");
    const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content);
    const text = content.find((item) => item.type === "text");
    return schema.parse(result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text ?? "") : undefined));
  }
  async check() {
    await this.connected(async (client) => {
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        if (page.nextCursor === cursor && cursor) throw new Error("Invalid pagination");
        cursor = page.nextCursor;
        if (tools.length > 10000) throw new Error("Tool limit");
      } while (cursor);
      for (const [name, fields] of Object.entries({
        t3_thread_launch: ["clientRequestId", "runtimeMode", "workspaceStrategy", "projectId"],
        t3_thread_send: ["clientRequestId", "mode"],
        t3_thread_read: ["threadId", "afterPosition"],
        t3_thread_wait: ["threadId", "runId", "untilDelegatedWorkSettled"],
      })) {
        const tool = tools.find((t) => t.name === name);
        if (!tool || fields.some((f) => !tool.inputSchema.properties || !(f in tool.inputSchema.properties)))
          throw new Error("Required T3 capability missing");
      }
      let next: number | null = null;
      do {
        const page: {
          projects: { id: string; deletedAt: string | null; archivedAt?: string | null }[];
          nextCursor: number | null;
        } = await this.call(
          client,
          "t3_project_list",
          { limit: 100, ...(next === null ? {} : { cursor: next }) },
          z.object({
            projects: z.array(
              z.object({ id, deletedAt: z.string().nullable(), archivedAt: z.string().nullable().optional() }),
            ),
            nextCursor: z.number().nullable(),
          }),
        );
        if (page.projects.some((p) => p.id === this.config.projectId && !p.deletedAt && !p.archivedAt)) return;
        if (page.nextCursor !== null && page.nextCursor <= (next ?? -1)) throw new Error("Invalid project pagination");
        next = page.nextCursor;
      } while (next !== null);
      throw new Error("Configured project unavailable");
    });
  }
  private async read(client: Client, threadId: string, afterPosition?: number) {
    const read = await this.call(
      client,
      "t3_thread_read",
      {
        threadId,
        view: "messages",
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 20000,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      readSchema,
    );
    if (
      read.thread.threadId !== threadId ||
      read.thread.projectId !== this.config.projectId ||
      read.thread.parentThreadId !== null ||
      read.thread.runtimeMode !== this.config.runtimeMode
    )
      throw new Error("Thread binding or permission mode mismatch");
    return read;
  }
  async submit(key: string, message: string, previous?: Target): Promise<Target> {
    const requestId = createHash("sha256")
      .update(JSON.stringify([this.config.emberOrigin, this.config.botKey, key]))
      .digest("hex");
    return this.connected(async (client) => {
      if (previous) {
        const read = await this.read(client, previous.threadId);
        if (read.thread.activeRunId || read.thread.pendingRequestCount) throw new Error("T3 thread busy");
      }
      const args = previous
        ? { threadId: previous.threadId, message, mode: "queue", clientRequestId: requestId }
        : {
            projectId: this.config.projectId,
            title: `Ember ${key}`,
            message,
            clientRequestId: requestId,
            runtimeMode: this.config.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "worktree" },
          };
      const result = await this.call(
        client,
        previous ? "t3_thread_send" : "t3_thread_launch",
        args,
        accepted.extend({ projectId: id.optional(), delivery: z.string().optional() }),
      );
      if (
        previous
          ? result.threadId !== previous.threadId || !["started", "queued"].includes(result.delivery ?? "")
          : result.projectId !== this.config.projectId
      )
        throw new Error("Invalid acceptance");
      return { threadId: result.threadId, runId: result.runId, link: this.link(result.link, result.threadId) };
    });
  }
  async observe(target: Target): Promise<{ done: boolean; text: string; status: string }> {
    return this.connected(async (client) => {
      let page = await this.read(client, target.threadId);
      const run = page.recentRuns.find((r) => r.runId === target.runId);
      if (!run) throw new Error("Exact run not in recent history");
      const completion = await this.call(
        client,
        "t3_thread_wait",
        { threadId: target.threadId, runId: target.runId, timeoutMs: 1, untilDelegatedWorkSettled: true },
        z.object({
          threadId: id,
          runId: id.nullable(),
          status,
          timedOut: z.boolean(),
          resultRun: z.object({ runId: id, status }).optional(),
        }),
      );
      if (completion.threadId !== target.threadId) throw new Error("Wait target mismatch");
      if (completion.timedOut || !completion.resultRun)
        return { done: false, text: "", status: completion.status };
      const resultRun = completion.resultRun;
      if (!["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(resultRun.status))
        throw new Error("Nonterminal result run");
      page = await this.read(client, target.threadId);
      if (page.thread.activeRunId || page.thread.pendingRequestCount)
        return { done: false, text: "", status: "running" };
      const output = new Map<string, string>();
      for (let count = 0; ; count++) {
        for (const item of page.items)
          if (
            item.sourceThreadId === target.threadId &&
            item.runId === resultRun.runId &&
            item.createdBy === "agent" &&
            item.visibility === "local" &&
            item.type === "assistant_message" &&
            item.text
          )
            output.set(item.itemId, item.text + (item.textTruncated ? "\n[Truncated. Open T3.]" : ""));
        if (!page.hasMore) break;
        if (count >= 99 || page.nextPosition === null) throw new Error("Transcript pagination limit");
        const next = page.nextPosition;
        page = await this.read(client, target.threadId, next);
        if (page.hasMore && (page.nextPosition === null || page.nextPosition <= next))
          throw new Error("Invalid transcript pagination");
      }
      return { done: true, text: [...output.values()].join("\n\n").slice(0, 16000), status: resultRun.status };
    });
  }
}
