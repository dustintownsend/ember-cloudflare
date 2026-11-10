import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { z } from "zod/v4";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthTokensSchema,
  OAuthClientInformationSchema,
  type OAuthTokens,
  type OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type Config, safeFetch, networkUrl } from "./config.ts";

const savedSchema = z.object({
  endpoint: z.string(),
  client: OAuthClientInformationSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
});
export class OAuth implements OAuthClientProvider {
  private verifier = "";
  private stateValue = randomBytes(32).toString("base64url");
  readonly redirectUrl: string;
  private config: Config;
  private redirect: (url: URL) => void;
  constructor(
    config: Config,
    redirect: (url: URL) => void = () => {
      throw new Error("Run oauth to authorize T3");
    },
  ) {
    this.config = config;
    this.redirect = redirect;
    this.redirectUrl = `http://127.0.0.1:${config.oauthPort}/callback`;
  }
  get clientMetadata() {
    return {
      client_name: "Ember T3 bridge",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  private file() {
    return `${this.config.dataDir}/oauth.json`;
  }
  private read() {
    let fd: number;
    try {
      fd = openSync(this.file(), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { endpoint: this.config.mcpUrl };
      throw new Error("Cannot read OAuth credentials");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("OAuth file requires service ownership and mode 0600");
      const saved = savedSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (saved.endpoint !== this.config.mcpUrl) throw new Error("OAuth endpoint changed");
      return saved;
    } finally {
      closeSync(fd);
    }
  }
  private save(saved: z.infer<typeof savedSchema>) {
    const tmp = `${this.file()}.${randomBytes(8).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.file());
  }
  state() {
    return this.stateValue;
  }
  clientInformation() {
    return this.read().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ ...this.read(), client });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.save({ ...this.read(), tokens });
  }
  redirectToAuthorization(url: URL) {
    networkUrl(url.origin);
    this.redirect(url);
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("Restart OAuth setup");
    return this.verifier;
  }
  invalidateCredentials(scope: string) {
    const saved = this.read();
    if (scope === "all" || scope === "client") delete saved.client;
    if (scope === "all" || scope === "tokens") delete saved.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = "";
    this.save(saved);
  }
}
export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function setupOAuth(config: Config, show: (url: URL) => void) {
  const provider = new OAuth(config, show);
  let accept: (code: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    accept = resolve;
    fail = reject;
  });
  void code.catch(() => {});
  let consumed = false;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain");
    if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${config.oauthPort}`) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url ?? "/", provider.redirectUrl);
    if (
      url.pathname !== "/callback" ||
      consumed ||
      !sameSecret(url.searchParams.get("state") ?? "", provider.state())
    ) {
      res.writeHead(400).end();
      return;
    }
    const value = url.searchParams.get("code");
    if (!value || value.length > 8192 || url.searchParams.has("error")) {
      res.writeHead(400).end("Authorization rejected");
      return;
    }
    consumed = true;
    accept(value);
    res.end("Return to the terminal to confirm authorization.");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.oauthPort, "127.0.0.1", resolve);
  });
  const timer = setTimeout(() => fail(new Error("OAuth timed out")), 600000);
  try {
    if ((await auth(provider, { serverUrl: config.mcpUrl, fetchFn: safeFetch })) === "REDIRECT") {
      if (
        (await auth(provider, { serverUrl: config.mcpUrl, authorizationCode: await code, fetchFn: safeFetch })) !==
        "AUTHORIZED"
      )
        throw new Error("OAuth incomplete");
    }
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
