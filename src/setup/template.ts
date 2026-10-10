import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { githubRaw } from "./github.js";
import type { HorizonVersion } from "./horizon.js";

/**
 * The repository with the project docs that go next to a Horizon theme: shared CLAUDE.md and
 * customizations.md, one versions/<version>/THEME.md per Horizon version, and versions.json saying
 * which versions stores may run.
 */
export const TEMPLATE_REPO = "acoderacom/claude-horizon";
const TEMPLATE_REF = "main";
export const TEMPLATE_FILES = ["CLAUDE.md", "THEME.md", "customizations.md"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];

/** The template's versions.json: the Horizon versions stores may run. */
export interface TemplateIndex {
  /** The version new and mismatched stores move to. */
  current: HorizonVersion;
  /** Versions stores may run, newest first, each with the Shopify/horizon commit its THEME.md describes. */
  supported: HorizonVersion[];
}

/** What setup knows about the store and project, for the placeholders in CLAUDE.md and customizations.md. */
export interface ProjectDetails {
  store: string;
  /** The project's Horizon version, which THEME.md covers. */
  horizonVersion: string;
  devStore?: boolean;
  /** The live theme, when it's Horizon. */
  liveTheme?: { id: string; version?: string };
  /** Undefined when setup couldn't tell. */
  passwordProtected?: boolean;
  storefrontPassword?: string;
}

export interface ProjectDocsInput {
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

const STATUSES = ["supported", "draft", "retired"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads versions.json, refusing one setup can't rely on. */
export function parseTemplateIndex(text: string): TemplateIndex {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("versions.json isn't valid JSON");
  }
  if (!isObject(data) || !isObject(data.versions)) throw new Error("versions.json has no versions");

  const supported: HorizonVersion[] = [];
  for (const [version, entry] of Object.entries(data.versions)) {
    if (!semver.valid(version)) throw new Error(`versions.json lists "${version}", which isn't a version number`);
    const status = isObject(entry) ? entry.status : undefined;
    if (typeof status !== "string" || !STATUSES.includes(status)) {
      throw new Error(`versions.json gives ${version} no status (${STATUSES.join(", ")})`);
    }
    if (status !== "supported") continue;
    const sha = isObject(entry) ? entry.horizonCommit : undefined;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`versions.json gives the supported version ${version} no full horizonCommit`);
    }
    supported.push({ version, sha });
  }
  supported.sort((a, b) => semver.rcompare(a.version, b.version));

  const current = supported.find((horizon) => horizon.version === data.current);
  if (!current) {
    const named = typeof data.current === "string" ? ` ${data.current}` : "";
    throw new Error(`versions.json's current version${named} isn't a supported version`);
  }
  return { current, supported };
}

/** Downloads the template's versions.json. */
export async function loadTemplateIndex(): Promise<TemplateIndex> {
  return parseTemplateIndex(await githubRaw(TEMPLATE_REPO, TEMPLATE_REF, "versions.json"));
}

/** How the store's live theme compares with the versions the template supports. */
export type LiveThemeCheck =
  | { status: "match"; horizon: HorizonVersion }
  | { status: "older" | "newer"; version: string; current: HorizonVersion }
  | { status: "not-horizon"; name: string; current: HorizonVersion }
  | { status: "unknown"; reason: string; current: HorizonVersion };

/**
 * A project needs the live theme to be a supported Horizon version, since CLAUDE.md and THEME.md
 * describe that version. Any other theme is moved to the current version.
 */
export function checkLiveTheme(
  live: { name: string; themeName?: string; version?: string } | undefined,
  reason: string,
  index: TemplateIndex
): LiveThemeCheck {
  const { current } = index;
  if (!live) return { status: "unknown", reason, current };
  if (live.themeName !== "Horizon") return { status: "not-horizon", name: live.name, current };
  const version = live.version;
  if (!version || !semver.valid(version)) return { status: "unknown", reason: "its Horizon version couldn't be read", current };
  const horizon = index.supported.find((candidate) => candidate.version === version);
  if (horizon) return { status: "match", horizon };
  return { status: semver.lt(version, current.version) ? "older" : "newer", version, current };
}

const PLACEHOLDER = {
  store: "[agent: insert the store's myshopify.com domain]",
  storeKind: '[agent: insert "development store" or "live store"]',
  themeVersion: "[agent: insert the live theme's Horizon version]",
  themeId: "[agent: insert the live theme's ID, gid://shopify/OnlineStoreTheme/…]",
  password: "[agent: insert the password in backticks, or delete this line if the storefront has none]",
  horizonVersion: "[agent: insert the Horizon version THEME.md covers]",
};

/**
 * Fills in the placeholders setup knows the answer to and leaves the rest for Claude. In a CLAUDE.md
 * filled in earlier, it updates the store, live theme, password and Horizon version on their lines.
 */
export function fillTemplate(text: string, details: ProjectDetails): string {
  const { store, horizonVersion, devStore, liveTheme, storefrontPassword } = details;
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
      line = line.replaceAll(PLACEHOLDER.horizonVersion, () => horizonVersion);
      if (line.startsWith("- Store: ")) {
        line = put(line, /[a-z0-9][a-z0-9-]*\.myshopify\.com/, store);
        line = put(line, /(development|live) store/, storeKind);
      }
      if (line.startsWith("- Live theme: ")) {
        line = put(line, /gid:\/\/shopify\/OnlineStoreTheme\/\d+/, liveTheme?.id);
        line = put(line, /Horizon \d+\.\d+\.\d+/, liveTheme?.version ? `Horizon ${liveTheme.version}` : undefined);
      }
      if (line.startsWith("- Storefront password")) line = put(line, /`[^`]*`/, password);
      // The lines that name the Horizon version THEME.md covers
      if (line.includes("technical spec of stock Horizon ")) {
        line = put(line, /stock Horizon \d+\.\d+\.\d+/, `stock Horizon ${horizonVersion}`);
      }
      if (line.includes("`theme_version` ")) {
        line = put(line, /`theme_version` \d+\.\d+\.\d+/, `\`theme_version\` ${horizonVersion}`);
      }
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

// Where each project file comes from in the template
const SOURCE: Record<TemplateFile, (version: string) => string> = {
  "CLAUDE.md": () => "CLAUDE.md",
  "THEME.md": (version) => `versions/${version}/THEME.md`,
  "customizations.md": () => "customizations.md",
};

/**
 * Writes the template's docs for the project's Horizon version into dir. CLAUDE.md gets the store
 * filled in, and one that's already there keeps everything except those details. THEME.md is
 * replaced only when asked. customizations.md is the project's change log, so one that's already
 * there is always kept.
 */
export async function writeProjectDocs(dir: string, input: ProjectDocsInput): Promise<ProjectDocsResult> {
  // Everything is downloaded before anything is written
  const version = input.details.horizonVersion;
  const sources = await Promise.all(
    TEMPLATE_FILES.map((name) => githubRaw(TEMPLATE_REPO, TEMPLATE_REF, SOURCE[name](version)))
  );
  const template = new Map(TEMPLATE_FILES.map((name, i) => [name, sources[i]!]));

  const files: ProjectDocsResult["files"] = [];
  let placeholdersLeft = false;
  for (const name of TEMPLATE_FILES) {
    const file = path.join(dir, name);
    const current = await readIfExists(file);
    let next: string | undefined;
    if (name === "CLAUDE.md") {
      next = fillTemplate(current ?? template.get(name)!, input.details);
      placeholdersLeft = next.includes("[agent:");
    } else if (name === "THEME.md") {
      // The version's spec is copied as it is
      if (current === undefined || input.replaceThemeMd) next = template.get(name)!;
    } else if (current === undefined) {
      next = fillTemplate(template.get(name)!, input.details);
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
