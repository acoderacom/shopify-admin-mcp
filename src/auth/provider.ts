import type { Config } from "../utils/cli.js";

interface TokenState {
  token: string;
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 300_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export class AuthProvider {
  private config: Config;
  private tokenState: TokenState | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  /** Whether a rejected token can be replaced by requesting a new one. */
  get canRefresh(): boolean {
    return this.config.auth.mode === "client-credentials";
  }

  async getAccessToken(): Promise<string> {
    if (this.config.auth.mode === "access-token") {
      return this.config.auth.accessToken;
    }

    if (this.tokenState && Date.now() < this.tokenState.expiresAt - REFRESH_MARGIN_MS) {
      return this.tokenState.token;
    }

    return this.fetchToken();
  }

  async forceRefresh(): Promise<string> {
    if (this.config.auth.mode === "access-token") {
      return this.config.auth.accessToken;
    }
    this.tokenState = null;
    return this.fetchToken();
  }

  // Concurrent callers share a single in-flight token request
  private fetchToken(): Promise<string> {
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    if (this.config.auth.mode !== "client-credentials") {
      throw new Error("Cannot fetch token in access-token mode");
    }

    const { clientId, clientSecret } = this.config.auth;

    const res = await fetch(
      `https://${this.config.store}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OAuth token exchange failed (${res.status}): ${text.slice(0, 200)}`
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.tokenState = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.tokenState.token;
  }
}
