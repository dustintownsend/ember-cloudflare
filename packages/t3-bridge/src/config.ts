import { z } from "zod/v4";
import { readFileSync } from "node:fs";

export function networkUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Use HTTPS or loopback HTTP, without credentials, query or fragment");
  }
  return url;
}
const origin = z.string().transform((s, ctx) => {
  try {
    const url = networkUrl(s);
    if (url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "Expected HTTPS or loopback origin" });
    return z.NEVER;
  }
});
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(256);
export const configSchema = z
  .object({
    emberOrigin: origin,
    botKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(512),
    webhookSecret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
    allowedUsers: z.array(id).min(1),
    allowedRooms: z.array(id).min(1),
    mcpUrl: z.string().transform((s) => networkUrl(s).href),
    environmentId: z.string().min(1),
    projectId: z.string().min(1),
    t3Origin: origin,
    runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).default("approval-required"),
    dataDir: z.string().startsWith("/"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8790),
    oauthPort: z.number().int().min(1).max(65535).default(8791),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(file: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const payload = z.object({
  user: z.object({ id, name: z.string().max(1000) }),
  room: z.object({ id, name: z.string().max(1000), path: z.string().max(2000) }),
  message: z.object({
    id,
    path: z.string().max(2000),
    body: z.object({ plain: z.string().trim().min(1).max(16000), html: z.string().nullable() }),
  }),
});
export function parseDelivery(value: unknown, config: Config) {
  const p = payload.parse(value);
  if (!config.allowedUsers.includes(p.user.id) || !config.allowedRooms.includes(p.room.id))
    throw new Error("Forbidden");
  const expected = `/rooms/${p.room.id}/${config.botKey}/messages`;
  const callback = new URL(p.room.path, config.emberOrigin);
  if (
    callback.origin !== config.emberOrigin ||
    callback.pathname !== expected ||
    callback.hash ||
    callback.username ||
    callback.password ||
    [...callback.searchParams.keys()].some((k) => k !== "thread") ||
    callback.searchParams.getAll("thread").length > 1 ||
    !p.room.path.startsWith(expected)
  )
    throw new Error("Invalid callback");
  const parent = callback.searchParams.get("thread");
  if (parent !== null) id.parse(parent);
  return {
    key: `${p.room.id}:${p.message.id}`,
    conversation: `${p.room.id}:${parent ?? p.message.id}`,
    room: p.room.id,
    root: parent ?? p.message.id,
    followup: parent !== null,
    text: p.message.body.plain,
  };
}
export const deliverySchema = z.object({
  key: z.string(),
  conversation: z.string(),
  room: id,
  root: id,
  followup: z.boolean(),
  text: z.string(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const safeFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  networkUrl(url.origin);
  if (url.username || url.password) throw new Error("URL credentials forbidden");
  return fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20000)]),
  });
};
