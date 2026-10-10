import { AuthProvider } from "../auth/provider.js";
import { GraphQLClient } from "../graphql/client.js";
import { DEFAULT_API_VERSION, type Config } from "../utils/cli.js";
import type { AuthAnswers } from "./mcp-config.js";

export type VerifyResult = { ok: true; shopName: string } | { ok: false; message: string };

/** Checks the credentials with the same small query the server runs at startup. */
export async function verifyCredentials(store: string, auth: AuthAnswers): Promise<VerifyResult> {
  const config: Config = {
    store,
    apiVersion: DEFAULT_API_VERSION,
    readOnly: true,
    allowLiveThemeWrites: false,
    disableRawGraphql: false,
    auth:
      auth.mode === "access-token"
        ? { mode: "access-token", accessToken: auth.accessToken }
        : { mode: "client-credentials", clientId: auth.clientId, clientSecret: auth.clientSecret },
  };

  try {
    const client = new GraphQLClient(new AuthProvider(config), config);
    const res = await client.execute("{ shop { name } }");
    const shop = res.data?.shop as { name: string } | null | undefined;
    if (shop) return { ok: true, shopName: shop.name };
    return { ok: false, message: res.errors?.map((e) => e.message).join(", ") || "Shopify returned no shop" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
