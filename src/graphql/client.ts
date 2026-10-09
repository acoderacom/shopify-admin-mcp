import type { AuthProvider } from "../auth/provider.js";
import type { Config } from "../utils/cli.js";

export interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
  extensions?: Record<string, unknown>;
}

interface QueryCost {
  requestedQueryCost?: number;
  throttleStatus?: { currentlyAvailable: number; restoreRate: number };
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_THROTTLE_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(res: GraphQLResponse): boolean {
  return res.errors?.some((e) => e.extensions?.code === "THROTTLED") ?? false;
}

// Wait until the leaky bucket has restored enough points for the request
function throttleDelayMs(res: GraphQLResponse, attempt: number): number {
  const cost = res.extensions?.cost as QueryCost | undefined;
  const status = cost?.throttleStatus;
  if (cost?.requestedQueryCost && status?.restoreRate) {
    const deficit = cost.requestedQueryCost - status.currentlyAvailable;
    return Math.max(1000, Math.ceil((deficit / status.restoreRate) * 1000));
  }
  return 1000 * (attempt + 1);
}

export class GraphQLClient {
  private auth: AuthProvider;
  private endpoint: string;
  private apiVersion: string;
  private versionMismatchReported = false;

  constructor(auth: AuthProvider, config: Config) {
    this.auth = auth;
    this.apiVersion = config.apiVersion;
    this.endpoint = `https://${config.store}/admin/api/${config.apiVersion}/graphql.json`;
  }

  async execute(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse> {
    const body = JSON.stringify(
      variables ? { query, variables } : { query }
    );

    // Throttled requests are rejected before execution, so retrying them is safe even for mutations
    for (let attempt = 0; ; attempt++) {
      let res = await this.post(body, await this.auth.getAccessToken());

      if (res.status === 401 && this.auth.canRefresh) {
        res = await this.post(body, await this.auth.forceRefresh());
      }

      this.checkServedVersion(res);

      if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Shopify API request failed (${res.status}): ${text.slice(0, 500)}`
        );
      }

      const json = (await res.json()) as GraphQLResponse;

      if (isThrottled(json) && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(throttleDelayMs(json, attempt));
        continue;
      }

      return json;
    }
  }

  private post(body: string, token: string): Promise<Response> {
    return fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": token,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  // Shopify silently serves the oldest supported version when the requested one is retired
  private checkServedVersion(res: Response) {
    const served = res.headers.get("x-shopify-api-version");
    if (served && served !== this.apiVersion && !this.versionMismatchReported) {
      this.versionMismatchReported = true;
      console.error(
        `Warning: requested API version ${this.apiVersion} but Shopify served ${served}. The requested version is unsupported or not yet released.`
      );
    }
  }
}
