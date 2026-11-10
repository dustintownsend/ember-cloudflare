import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, safeFetch } from "./config.ts";
import { Store } from "./store.ts";
import { setupOAuth } from "./oauth.ts";
import { T3 } from "./t3.ts";
import { Bridge } from "./bridge.ts";

export async function main(args: string[]) {
  const [command, file] = args;
  if (command === "--help" || command === "help") {
    process.stdout.write(
      "Ember T3 bridge\nUsage: node src/cli.ts <oauth|check|serve|status|resolve|dismiss> /absolute/config.json\n",
    );
    return;
  }
  if (!file || !["oauth", "check", "serve", "status", "resolve", "dismiss"].includes(command ?? ""))
    throw new Error("Invalid arguments. Use --help");
  const config = loadConfig(file);
  if (command === "status") {
    try {
      const response = await safeFetch(`http://127.0.0.1:${config.port}/status/${config.webhookSecret}`);
      if (response.ok) {
        process.stdout.write((await response.text()) + "\n");
        return;
      }
    } catch {}
  }
  const store = new Store(config, command !== "status");
  const t3 = new T3(config);
  if (command === "serve") {
    try {
      await t3.check();
    } catch {
      store.close();
      throw new Error("T3 connection check failed");
    }
    const bridge = new Bridge(config, store, t3);
    const server = bridge.server();
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(config.port, config.host, ok);
    });
    const timer = setInterval(() => {
      void bridge.tick().catch(() => process.stderr.write("Bridge scheduler failed. Inspect status.\n"));
    }, 5000);
    process.stdout.write("Ember T3 bridge listening. Inspect jobs with status.\n");
    const stop = () => {
      clearInterval(timer);
      server.close();
      setTimeout(() => process.exit(0), 25000).unref();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }
  try {
    if (command === "resolve" || command === "dismiss") {
      const job = store.jobs().find((j) => j.delivery.key === args[2]);
      if (!job || !["unknown", "failed", "running", "reply-pending"].includes(job.state.kind))
        throw new Error("Job not reconcilable");
      if (command === "dismiss") store.save(job.delivery.key, { kind: "dismissed" });
      else {
        const threadId = args[3],
          runId = args[4];
        if (!threadId || !runId) throw new Error("Supply verified thread and run IDs");
        const target = { threadId, runId, link: null };
        await t3.observe(target);
        store.accepted(job, target);
      }
      process.stdout.write("Job reconciled. Start serve to resume.\n");
    }
    if (command === "oauth") {
      await setupOAuth(config, (url) => process.stdout.write(`Authorize in your browser:\n${url.href}\n`));
      await t3.check();
      process.stdout.write("OAuth saved. Environment and project verified.\n");
    }
    if (command === "check") {
      await t3.check();
      process.stdout.write("T3 capabilities, environment and project verified.\n");
    }
    if (command === "status")
      process.stdout.write(
        JSON.stringify(
          store.jobs().map((j) => ({ key: j.delivery.key, conversation: j.delivery.conversation, state: j.state })),
          null,
          2,
        ) + "\n",
      );
  } finally {
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Bridge failed. Check arguments, configuration, private data directory and T3 authorization. Use --help. No credentials printed.\n",
    );
    process.exitCode = 1;
  });
}
