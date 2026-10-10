import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { fetchArchive, githubApi } from "./github.js";

/** The repository with the project docs that go next to a Horizon theme, tagged per Horizon version. */
export const TEMPLATE_REPO = "acoderacom/claude-horizon";
export const TEMPLATE_FILES = ["CLAUDE.md", "THEME.md", "customizations.md"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];

/** What setup knows about the store, for CLAUDE.md. */
export interface ProjectDetails {
  store: string;
  devStore?: boolean;
  /** The live theme, when it's Horizon. */
  liveTheme?: { id: string; version?: string };
  /** Undefined when setup couldn't tell. */
  passwordProtected?: boolean;
  storefrontPassword?: string;
}

export interface ProjectDocsInput {
  /** The Horizon version whose docs to use. */
  docsVersion: string;
  /** Replace an existing THEME.md, since it describes the theme being replaced. */
  replaceThemeMd: boolean;
  details: ProjectDetails;
}

export type DocAction = "created" | "updated" | "replaced" | "unchanged" | "kept";

export interface ProjectDocsResult {
  files: Array<{ name: TemplateFile; action: DocAction }>;
  /** Whether CLAUDE.md still has [agent: …] placeholders for Claude to fill in. */
  placeholdersLeft: boolean;
}

/** Lists the Horizon versions the template has docs for, newest first, from its horizon-X.Y.Z tags. */
export async function listDocsVersions(): Promise<string[]> {
  const tags = await githubApi<Array<{ name: string }>>(`repos/${TEMPLATE_REPO}/tags?per_page=100`);
  return tags
    .map((tag) => /^horizon-(\d+\.\d+\.\d+)$/.exec(tag.name)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort(semver.rcompare);
}

/** How the store's live theme compares with the Horizon versions the template has docs for. */
export type LiveThemeCheck =
  | { status: "match"; version: string }
  | { status: "older" | "newer"; version: string; templateVersion: string }
  | { status: "not-horizon"; name: string; templateVersion: string }
  | { status: "unknown"; reason: string; templateVersion: string };

/**
 * A project needs the live theme to be a Horizon version the template covers, since CLAUDE.md and
 * THEME.md describe that version. When it isn't, the newest template version is the one to move to.
 */
export function checkLiveTheme(
  live: { name: string; themeName?: string; version?: string } | undefined,
  reason: string,
  docsVersions: string[]
): LiveThemeCheck {
  const templateVersion = docsVersions[0]!;
  if (!live) return { status: "unknown", reason, templateVersion };
  if (live.themeName !== "Horizon") return { status: "not-horizon", name: live.name, templateVersion };
  const version = live.version;
  if (!version || !semver.valid(version)) return { status: "unknown", reason: "its Horizon version couldn't be read", templateVersion };
  if (docsVersions.includes(version)) return { status: "match", version };
  return { status: semver.lt(version, templateVersion) ? "older" : "newer", version, templateVersion };
}

const PLACEHOLDER = {
  store: "[agent: insert the store's myshopify.com domain]",
  storeKind: '[agent: insert "development store" or "live store"]',
  themeVersion: "[agent: insert the live theme's Horizon version]",
  themeId: "[agent: insert the live theme's ID, gid://shopify/OnlineStoreTheme/…]",
  password: "[agent: insert the password in backticks, or delete this line if the storefront has none]",
};

/**
 * Fills in the placeholders setup knows the answer to and leaves the rest for Claude. In a CLAUDE.md
 * filled in earlier, it updates the store, live theme and password on their lines instead.
 */
export function fillClaudeMd(text: string, details: ProjectDetails): string {
  const { store, devStore, liveTheme, storefrontPassword } = details;
  const storeKind = devStore === undefined ? undefined : devStore ? "development store" : "live store";
  const password = storefrontPassword ? `\`${storefrontPassword}\`` : undefined;
  // Values go in through functions, so a "$" in a password isn't read as a replacement pattern
  const put = (line: string, pattern: string | RegExp, value: string | undefined) =>
    value === undefined ? line : line.replace(pattern, () => value);

  return text
    .split("\n")
    .flatMap((line) => {
      if (line.includes(PLACEHOLDER.password) && !storefrontPassword && details.passwordProtected === false) return [];
      line = put(line, PLACEHOLDER.store, store);
      line = put(line, PLACEHOLDER.storeKind, storeKind);
      line = put(line, PLACEHOLDER.themeId, liveTheme?.id);
      line = put(line, PLACEHOLDER.themeVersion, liveTheme?.version);
      line = put(line, PLACEHOLDER.password, password);
      if (line.startsWith("- Store: ")) {
        line = put(line, /[a-z0-9][a-z0-9-]*\.myshopify\.com/, store);
        line = put(line, /(development|live) store/, storeKind);
      }
      if (line.startsWith("- Live theme: ")) {
        line = put(line, /gid:\/\/shopify\/OnlineStoreTheme\/\d+/, liveTheme?.id);
        line = put(line, /Horizon \d+\.\d+\.\d+/, liveTheme?.version ? `Horizon ${liveTheme.version}` : undefined);
      }
      if (line.startsWith("- Storefront password")) line = put(line, /`[^`]*`/, password);
      return [line];
    })
    .join("\n");
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Writes the template's docs into dir. CLAUDE.md gets the store filled in, and one that's already
 * there keeps everything except those details. THEME.md is replaced only when asked.
 * customizations.md is the project's change log, so one that's already there is always kept.
 */
export async function writeProjectDocs(dir: string, input: ProjectDocsInput): Promise<ProjectDocsResult> {
  // Everything is downloaded before anything is written
  const archive = await fetchArchive(TEMPLATE_REPO, `horizon-${input.docsVersion}`);
  const template = new Map(archive.map((file) => [file.path, file.data.toString("utf8")]));
  const missing = TEMPLATE_FILES.filter((name) => !template.has(name));
  if (missing.length > 0) throw new Error(`The template is missing ${missing.join(", ")}`);

  const files: ProjectDocsResult["files"] = [];
  let placeholdersLeft = false;
  for (const name of TEMPLATE_FILES) {
    const file = path.join(dir, name);
    const current = await readIfExists(file);
    let next: string | undefined;
    if (name === "CLAUDE.md") {
      next = fillClaudeMd(current ?? template.get(name)!, input.details);
      placeholdersLeft = next.includes("[agent:");
    } else if (current === undefined || (name === "THEME.md" && input.replaceThemeMd)) {
      next = template.get(name)!;
    }

    let action: DocAction;
    if (next === undefined) action = "kept";
    else if (current === undefined) action = "created";
    else if (next === current) action = "unchanged";
    else action = name === "CLAUDE.md" ? "updated" : "replaced";

    if (next !== undefined && next !== current) await writeFile(file, next);
    files.push({ name, action });
  }
  return { files, placeholdersLeft };
}
