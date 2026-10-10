import { AuthProvider } from "../auth/provider.js";
import { GraphQLClient } from "../graphql/client.js";
import { DEFAULT_API_VERSION, type Config } from "../utils/cli.js";
import type { AuthAnswers } from "./mcp-config.js";

export interface LiveTheme {
  id: string;
  name: string;
  /** theme_name and theme_version from its config/settings_schema.json, when it has them. */
  themeName?: string;
  version?: string;
}

export interface StoreInfo {
  shopName: string;
  devStore?: boolean;
  passwordProtected?: boolean;
  liveTheme?: LiveTheme;
  /** Why the live theme couldn't be read, such as a missing read_themes scope. */
  liveThemeError?: string;
}

export type VerifyResult = ({ ok: true } & StoreInfo) | { ok: false; message: string };

// Each field is read separately, so one the app has no scope for doesn't hide the others
const DETAILS_QUERY = `{
  shop { plan { partnerDevelopment } }
  onlineStore { passwordProtection { enabled } }
  themes(first: 1, roles: [MAIN]) {
    nodes {
      id
      name
      files(filenames: ["config/settings_schema.json"], first: 1) {
        nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }
}`;

interface Details {
  shop?: { plan?: { partnerDevelopment?: boolean } } | null;
  onlineStore?: { passwordProtection?: { enabled?: boolean } } | null;
  themes?: {
    nodes: Array<{ id: string; name: string; files?: { nodes: Array<{ body?: { content?: string } }> } | null }>;
  } | null;
}

// The theme_info entry of settings_schema.json; a regex also copes with comments in the file
function themeInfo(schema: string | undefined, key: "theme_name" | "theme_version"): string | undefined {
  return schema && new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(schema)?.[1];
}

/**
 * Checks the credentials with the same small query the server runs at startup, then reads what
 * setup can use for a Horizon project: the store type, the storefront password setting, and the
 * live theme.
 */
export async function verifyCredentials(store: string, auth: AuthAnswers): Promise<VerifyResult> {
  const config: Config = {
    store,
    apiVersion: DEFAULT_API_VERSION,
    readOnly: true,
    allowLiveThemeWrites: false,
    disableThemeWrites: true,
    disableRawGraphql: false,
    auth:
      auth.mode === "access-token"
        ? { mode: "access-token", accessToken: auth.accessToken }
        : { mode: "client-credentials", clientId: auth.clientId, clientSecret: auth.clientSecret },
  };

  const client = new GraphQLClient(new AuthProvider(config), config);
  let shopName: string;
  try {
    const res = await client.execute("{ shop { name } }");
    const shop = res.data?.shop as { name: string } | null | undefined;
    if (!shop) return { ok: false, message: res.errors?.map((e) => e.message).join(", ") || "Shopify returned no shop" };
    shopName = shop.name;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const info: StoreInfo = { shopName };
  try {
    const res = await client.execute(DETAILS_QUERY);
    const data = (res.data ?? {}) as Details;
    info.devStore = data.shop?.plan?.partnerDevelopment;
    info.passwordProtected = data.onlineStore?.passwordProtection?.enabled;
    const theme = data.themes?.nodes[0];
    if (theme) {
      const schema = theme.files?.nodes[0]?.body?.content;
      info.liveTheme = {
        id: theme.id,
        name: theme.name,
        themeName: themeInfo(schema, "theme_name"),
        version: themeInfo(schema, "theme_version"),
      };
    } else {
      info.liveThemeError =
        (res.errors?.find((e) => e.path?.[0] === "themes") ?? res.errors?.[0])?.message ??
        (data.themes ? "the store has no live theme" : "Shopify didn't return it");
    }
  } catch (err) {
    info.liveThemeError = err instanceof Error ? err.message : String(err);
  }
  return { ok: true, ...info };
}
