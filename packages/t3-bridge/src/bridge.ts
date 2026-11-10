import { MAX_MESSAGE_LENGTH } from "@ember/protocol";
import { createServer, type IncomingMessage } from "node:http";
import { type Config, parseDelivery, safeFetch } from "./config.ts";
import { sameSecret } from "./oauth.ts";
import { Store, type Job } from "./store.ts";
import { T3 } from "./t3.ts";

export function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new Error("Payload too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class Bridge {
  private ticking = false;
  readonly config: Config;
  readonly store: Store;
  readonly t3: Pick<T3, "submit" | "observe">;
  constructor(config: Config, store: Store, t3: Pick<T3, "submit" | "observe">) {
    this.config = config;
    this.store = store;
    this.t3 = t3;
  }
  server() {
    const server = createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "GET" && sameSecret(req.url ?? "", `/status/${this.config.webhookSecret}`)) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            this.store
              .jobs()
              .map((j) => ({ key: j.delivery.key, conversation: j.delivery.conversation, state: j.state })),
          ),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.end("Bridge process ready");
        return;
      }
      if (req.method !== "POST" || !sameSecret(req.url ?? "", `/webhook/${this.config.webhookSecret}`)) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
        res.writeHead(415).end();
        return;
      }
      try {
        const delivery = parseDelivery(await body(req), this.config);
        if (delivery.followup && !this.store.jobs().some((j) => j.delivery.conversation === delivery.conversation)) {
          res.writeHead(409).end("Start with a top-level message mentioning this bot");
          return;
        }
        this.store.enqueue(delivery);
        res.writeHead(202).end();
      } catch {
        res.writeHead(400).end("Delivery rejected");
      }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    return server;
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const blocked = new Set<string>();
      for (const job of this.store.jobs()) {
        if (blocked.has(job.delivery.conversation) || ["completed", "dismissed"].includes(job.state.kind)) continue;
        blocked.add(job.delivery.conversation);
        await this.advance(job);
      }
    } finally {
      this.ticking = false;
    }
  }
  private async advance(job: Job) {
    const { delivery, state } = job;
    switch (state.kind) {
      case "queued": {
        this.store.save(delivery.key, { kind: "submitting" });
        try {
          const previous = this.store.binding(delivery.conversation);
          if (delivery.followup && !previous) {
            this.store.save(delivery.key, {
              kind: "failed",
              reason: "No accepted T3 conversation. Reconcile the root message.",
            });
            return;
          }
          const target = await this.t3.submit(delivery.key, delivery.text, previous);
          this.store.accepted(job, target);
        } catch {
          this.store.save(delivery.key, {
            kind: "unknown",
            reason: "Submission acknowledgement unavailable. Inspect T3 before resolving. Never automatically retry.",
          });
        }
        return;
      }
      case "running": {
        try {
          const observed = await this.t3.observe(state.target);
          if (observed.done) {
            const prefix = `[T3 ${observed.status}]\n`;
            const suffix = `\n${state.target.link ?? "T3 link unavailable"}\n[Ember delivery ${delivery.key}]`;
            const notice = "\n[Truncated. Open T3 for the full reply.]";
            const text = observed.text || "No assistant text returned.";
            const budget = MAX_MESSAGE_LENGTH - prefix.length - suffix.length;
            const output = text.length > budget ? text.slice(0, budget - notice.length) + notice : text;
            const reply = prefix + output + suffix;
            this.store.save(delivery.key, { kind: "reply-pending", target: state.target, reply });
          } else
            this.store.save(delivery.key, {
              ...state,
              error: observed.status === "waiting" ? "Waiting for input or approval. Open T3." : undefined,
            });
        } catch {
          this.store.save(delivery.key, {
            ...state,
            error: "Cannot observe exact T3 run. Check OAuth, connection and T3. Observation will retry.",
          });
        }
        return;
      }
      case "reply-pending": {
        const callback = new URL(`/rooms/${delivery.room}/${this.config.botKey}/messages`, this.config.emberOrigin);
        callback.searchParams.set("thread", delivery.root);
        this.store.save(delivery.key, { kind: "delivering", target: state.target, reply: state.reply });
        try {
          const response = await safeFetch(callback, {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: `<p>${escapeHtml(state.reply).replaceAll("\n", "<br>")}</p>`,
          });
          await response.body?.cancel();
          if (response.status !== 201) throw new Error("Callback rejected");
          this.store.save(delivery.key, { kind: "completed", target: state.target });
        } catch {
          this.store.save(delivery.key, {
            kind: "unknown",
            reason:
              "Reply delivery uncertain. Inspect Ember for the delivery marker before resolving. Never automatically retry.",
            target: state.target,
          });
        }
        return;
      }
      case "dismissed":
      case "submitting":
      case "delivering":
      case "completed":
      case "failed":
      case "unknown":
        return;
    }
  }
}
