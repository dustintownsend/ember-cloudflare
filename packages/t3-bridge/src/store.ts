import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { z } from "zod/v4";
import { deliverySchema, type Delivery, type Config } from "./config.ts";

const target = z.object({ threadId: z.string(), runId: z.string(), link: z.string().nullable() });
export type Target = z.infer<typeof target>;
const state = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("submitting") }),
  z.object({ kind: z.literal("running"), target, error: z.string().optional() }),
  z.object({ kind: z.literal("reply-pending"), target, reply: z.string() }),
  z.object({ kind: z.literal("delivering"), target, reply: z.string() }),
  z.object({ kind: z.literal("completed"), target }),
  z.object({ kind: z.literal("dismissed") }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
  z.object({ kind: z.literal("unknown"), reason: z.string(), target: target.optional() }),
]);
export type State = z.infer<typeof state>;
export type Job = { delivery: Delivery; state: State };
export class Store {
  readonly db: DatabaseSync;
  constructor(config: Config, recover = true) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(config.dataDir);
    if (!directory.isDirectory() || directory.mode & 0o077 || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error("Data directory requires service ownership and mode 0700");
    }
    this.db = new DatabaseSync(`${config.dataDir}/bridge.sqlite`);
    chmodSync(`${config.dataDir}/bridge.sqlite`, 0o600);
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, conversation TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, target TEXT NOT NULL);`);
    const binding = JSON.stringify([
      config.emberOrigin,
      config.botKey,
      config.mcpUrl,
      config.environmentId,
      config.projectId,
      config.runtimeMode,
      config.t3Origin,
    ]);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES(1, ?)").run(binding);
    const saved = this.db.prepare("SELECT binding FROM settings WHERE id=1").get();
    if (saved?.binding !== binding) {
      this.db.close();
      throw new Error("Data directory belongs to different bridge configuration");
    }
    for (const job of recover ? this.jobs() : []) {
      if (job.state.kind === "submitting" || job.state.kind === "delivering")
        this.save(job.delivery.key, {
          kind: "unknown",
          reason: `${job.state.kind} interrupted; reconcile manually in T3 or Ember`,
          ...(job.state.kind === "delivering" ? { target: job.state.target } : {}),
        });
    }
  }
  enqueue(delivery: Delivery) {
    const existing = this.db.prepare("SELECT delivery FROM jobs WHERE key=?").get(delivery.key);
    if (existing && existing.delivery !== JSON.stringify(delivery)) throw new Error("Conflicting duplicate delivery");
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO jobs(key,conversation,delivery,state) VALUES(?,?,?,?)")
        .run(delivery.key, delivery.conversation, JSON.stringify(delivery), JSON.stringify({ kind: "queued" }))
        .changes !== 0
    );
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT delivery,state FROM jobs ORDER BY seq")
      .all()
      .map((row) => ({
        delivery: deliverySchema.parse(JSON.parse(z.string().parse(row.delivery))),
        state: state.parse(JSON.parse(z.string().parse(row.state))),
      }));
  }
  save(key: string, state: State) {
    this.db.prepare("UPDATE jobs SET state=? WHERE key=?").run(JSON.stringify(state), key);
  }
  binding(key: string): Target | undefined {
    const row = this.db.prepare("SELECT target FROM conversations WHERE key=?").get(key);
    return row ? target.parse(JSON.parse(z.string().parse(row.target))) : undefined;
  }
  bind(key: string, target: Target) {
    this.db
      .prepare("INSERT INTO conversations VALUES(?,?) ON CONFLICT(key) DO UPDATE SET target=excluded.target")
      .run(key, JSON.stringify(target));
  }
  accepted(job: Job, target: Target) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.bind(job.delivery.conversation, target);
      this.save(job.delivery.key, { kind: "running", target });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
