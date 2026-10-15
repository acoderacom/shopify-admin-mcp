import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Gets an Admin API access token for an app that's installed on a store outside the app's
 * organization, where the client credentials grant is refused: the user approves the app in the
 * browser, Shopify redirects to a local callback with a code, and the code is exchanged for an
 * offline access token (the authorization code grant).
 */
export const OAUTH_PORT = 3457;
export const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const TIMEOUT_MS = 5 * 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const SHOP_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export interface ApprovalInput {
  store: string;
  clientId: string;
  clientSecret: string;
  /** Comma-separated scopes; empty asks for the scopes on the app's released version. */
  scopes: string;
}

export interface ApprovalResult {
  accessToken: string;
  /** The scopes Shopify granted, comma-separated. */
  scope: string;
}

export function authorizeUrl(input: ApprovalInput, state: string): string {
  const params = new URLSearchParams({ client_id: input.clientId, redirect_uri: REDIRECT_URI, state });
  if (input.scopes.trim()) params.set("scope", input.scopes.trim());
  return `https://${input.store}/admin/oauth/authorize?${params}`;
}

/**
 * Checks the callback came from Shopify for this store and this request: the shop, the state
 * nonce, and the HMAC Shopify signs the other parameters with. Returns the code.
 */
export function verifyCallback(params: URLSearchParams, input: ApprovalInput, state: string): string {
  const shop = params.get("shop") ?? "";
  if (!SHOP_PATTERN.test(shop) || shop !== input.store) throw new Error(`The approval came back for ${shop || "no store"}, not ${input.store}`);
  if (params.get("state") !== state) throw new Error("The approval didn't match this setup run (state mismatch)");

  const hmac = params.get("hmac") ?? "";
  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", input.clientSecret).update(message).digest("hex");
  const given = Buffer.from(hmac, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected, "utf8"))) {
    throw new Error("The approval's signature didn't match the client secret");
  }

  const code = params.get("code");
  if (!code) throw new Error("Shopify sent no authorization code");
  return code;
}

/** Exchanges the code for an offline access token, which lasts until the app is uninstalled or its secret rotated. */
export async function exchangeCode(input: ApprovalInput, code: string): Promise<ApprovalResult> {
  const res = await fetch(`https://${input.store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: { access_token?: string; scope?: string; error_description?: string; error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Shopify answers some failures with an HTML page
  }
  if (!res.ok || !body.access_token) {
    const reason = body.error_description ?? body.error ?? /Oauth error ([a-z_]+)/.exec(text)?.[1] ?? `HTTP ${res.status}`;
    throw new Error(`Shopify didn't exchange the code for a token: ${reason}`);
  }
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

function page(title: string, text: string): string {
  const escape = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(text)}</p></body>`;
}

/** Opens a URL in the default browser; the URL is also printed, so a failure here isn't fatal. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL still works
  }
}

/**
 * Waits on the local redirect URI for Shopify's callback after the user approves the app in the
 * browser, then exchanges the code. onUrl receives the approval URL to print and open. The server
 * listens on the loopback addresses only, IPv4 and IPv6, since browsers may try either for localhost.
 */
export async function approveInBrowser(
  input: ApprovalInput,
  onUrl: (url: string) => void,
  timeoutMs = TIMEOUT_MS
): Promise<ApprovalResult> {
  const state = randomBytes(16).toString("hex");
  const servers: Server[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ApprovalResult>((resolve, reject) => {
      // Settles only after the browser has its page, so closing the servers doesn't cut it off
      const reply = (res: ServerResponse, status: number, title: string, text: string, settle: () => void) =>
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, text), settle);

      const handle = (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404).end();
          return;
        }
        let code: string;
        try {
          code = verifyCallback(url.searchParams, input, state);
        } catch (err) {
          reply(res, 400, "Approval not accepted", (err as Error).message, () => reject(err));
          return;
        }
        exchangeCode(input, code).then(
          (result) =>
            reply(res, 200, "App approved", "Setup has the access token. Close this tab and return to the terminal.", () =>
              resolve(result)
            ),
          (err: Error) => reply(res, 502, "Approval failed", err.message, () => reject(err))
        );
      };

      const listen = (host: string) =>
        new Promise<boolean>((done, fail) => {
          const server = createServer(handle);
          server.once("error", (err: NodeJS.ErrnoException) => {
            // A machine without IPv6 just has no ::1
            if (host === "::1" && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) done(false);
            else fail(err);
          });
          server.listen(OAUTH_PORT, host, () => {
            servers.push(server);
            done(true);
          });
        });

      Promise.all([listen("127.0.0.1"), listen("::1")]).then(
        () => {
          onUrl(authorizeUrl(input, state));
          timer = setTimeout(() => reject(new Error("No approval arrived within 5 minutes")), timeoutMs);
        },
        (err: NodeJS.ErrnoException) =>
          reject(
            err.code === "EADDRINUSE"
              ? new Error(`Port ${OAUTH_PORT} is in use, so setup can't receive the approval. Close what's using it and try again.`)
              : err
          )
      );
    });
  } finally {
    clearTimeout(timer);
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  }
}
