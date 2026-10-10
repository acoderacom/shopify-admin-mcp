import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import * as p from "@clack/prompts";
import { TOOLSETS, isValidStore, normalizeStore, type Toolset } from "../utils/cli.js";
import {
  CONFIG_FILE,
  type AdvancedAnswers,
  type AuthAnswers,
  type ExistingSetup,
  type SaveResult,
  type SetupAnswers,
} from "./mcp-config.js";
import { THEME_DIR, type DownloadResult, type HorizonVersion } from "./horizon.js";
import type { NodeCheck } from "./node-version.js";
import { docsVersionFor, type ProjectDetails, type ProjectDocsInput, type ProjectDocsResult } from "./template.js";
import type { StoreInfo, VerifyResult } from "./verify.js";

export type SetupOutcome = "saved" | "cancelled" | "failed";

export interface WizardOptions {
  cwd: string;
  existing: ExistingSetup;
  /** The running Node.js version, e.g. v24.15.0. */
  nodeVersion: string;
  adminNode: NodeCheck;
  checkDevMcpNode: () => Promise<NodeCheck>;
  verify: (store: string, auth: AuthAnswers) => Promise<VerifyResult>;
  save: (answers: SetupAnswers) => Promise<SaveResult>;
  listHorizonVersions: () => Promise<HorizonVersion[]>;
  /** Downloads Horizon into the theme folder, replacing what's there. */
  downloadHorizon: (horizon: HorizonVersion) => Promise<DownloadResult>;
  /** Lists the Horizon versions the project docs cover. */
  listDocsVersions: () => Promise<string[]>;
  writeProjectDocs: (input: ProjectDocsInput) => Promise<ProjectDocsResult>;
  /** Streams the prompts use instead of the terminal, for tests. */
  input?: Readable;
  output?: Writable;
}

// The folder the "create an uploads folder" option points at
const UPLOADS_FOLDER = "uploads";

const AUTH_LABELS: Record<AuthAnswers["mode"], string> = {
  "access-token": "Access token",
  "client-credentials": "Client ID and secret",
};

class Cancelled extends Error {}

interface ProjectAnswer {
  horizon: HorizonVersion;
  /** The Horizon version whose docs are used. */
  docsVersion: string;
  /** Whether the theme folder has files or THEME.md exists, which the project replaces. */
  replace: boolean;
  storefrontPassword?: string;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function resolveFolder(cwd: string, input: string): string {
  const expanded = input === "~" || input.startsWith("~/") ? path.join(homedir(), input.slice(1)) : input;
  return path.resolve(cwd, expanded);
}

function pathKind(target: string): "folder" | "file" | "missing" {
  try {
    return statSync(target).isDirectory() ? "folder" : "file";
  } catch {
    return "missing";
  }
}

function releaseDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function describeNode(check: NodeCheck, nodeVersion: string): string {
  const shortfall = check.ok ? "" : `, but this is ${nodeVersion}`;
  const note = check.note ? ` (${check.note})` : "";
  return `${check.label} needs Node.js ${check.range}${shortfall}${note}`;
}

function describeAdvanced(advanced: AdvancedAnswers): string {
  const parts: string[] = [];
  if (advanced.readOnly) parts.push("read-only");
  if (advanced.allowLiveThemeWrites) parts.push("live theme writes allowed");
  if (advanced.uploadDir) parts.push(`uploads from ${advanced.uploadDir}`);
  if (advanced.toolsets) parts.push(`toolsets: ${advanced.toolsets.join(", ")}`);
  if (advanced.disableRawGraphql) parts.push("raw GraphQL off");
  return parts.length ? parts.join("; ") : "defaults";
}

/** Asks the setup questions, then saves .mcp.json when confirmed. */
export async function runWizard(options: WizardOptions): Promise<SetupOutcome> {
  const { cwd, existing, nodeVersion, adminNode, verify, save } = options;
  const io = { input: options.input, output: options.output };
  const file = path.join(cwd, CONFIG_FILE);

  // Prompts resolve to a cancel symbol on Ctrl+C or Escape; this ends the wizard instead
  const ask = async <T>(answer: Promise<T>): Promise<Exclude<T, symbol>> => {
    const value = await answer;
    if (p.isCancel(value)) throw new Cancelled();
    return value as Exclude<T, symbol>;
  };

  const askStore = async (current: string) =>
    normalizeStore(
      await ask(
        p.text({
          ...io,
          message: "Store domain",
          placeholder: "mystore.myshopify.com",
          initialValue: current,
          validate: (value) =>
            value?.trim() && isValidStore(normalizeStore(value))
              ? undefined
              : "Use your store's myshopify.com domain, e.g. mystore.myshopify.com",
        })
      )
    );

  // Enter on an empty secret keeps the one already known
  const askSecret = async (label: string, current: string) => {
    const value = await ask(
      p.password({
        ...io,
        message: current ? `${label} (press Enter to keep the current one)` : label,
        validate: (input) => (input?.trim() || current ? undefined : `Enter the ${label.toLowerCase()}`),
      })
    );
    return value.trim() || current;
  };

  const askAuth = async (current: AuthAnswers | undefined): Promise<AuthAnswers> => {
    const mode = await ask(
      p.select<AuthAnswers["mode"]>({
        ...io,
        message: "How does the app authenticate?",
        initialValue: current?.mode ?? existing.authMode ?? "access-token",
        options: [
          { value: "access-token", label: AUTH_LABELS["access-token"], hint: "legacy custom app, shpat_…" },
          { value: "client-credentials", label: AUTH_LABELS["client-credentials"], hint: "Dev Dashboard app" },
        ],
      })
    );
    if (mode === "access-token") {
      const known = current?.mode === "access-token" ? current.accessToken : (existing.accessToken ?? "");
      return { mode, accessToken: await askSecret("Admin API access token", known) };
    }
    const clientId = await ask(
      p.text({
        ...io,
        message: "Client ID",
        initialValue: current?.mode === "client-credentials" ? current.clientId : (existing.clientId ?? ""),
        validate: (value) => (value?.trim() ? undefined : "Enter the client ID"),
      })
    );
    const known = current?.mode === "client-credentials" ? current.clientSecret : (existing.clientSecret ?? "");
    return { mode, clientId: clientId.trim(), clientSecret: await askSecret("Client secret", known) };
  };

  const askUploadDir = async (current: string | undefined): Promise<string | undefined> => {
    const uploads = resolveFolder(cwd, UPLOADS_FOLDER);
    const choices: Array<{ value: string; label: string; hint?: string }> = [];
    if (current) choices.push({ value: "keep", label: `Keep ${current}`, hint: "current" });
    if (current !== uploads) {
      choices.push(
        pathKind(uploads) === "folder"
          ? { value: "uploads", label: `Use ${uploads}` }
          : { value: "uploads", label: "Create an uploads folder here", hint: `${uploads}, created when you save` }
      );
    }
    choices.push({ value: "custom", label: "Choose another folder" }, { value: "off", label: "Keep local uploads off" });

    const choice = await ask(p.select({ ...io, message: "Local file uploads", options: choices }));
    if (choice === "keep") return current;
    if (choice === "uploads") return uploads;
    if (choice === "off") return undefined;

    let suggestion = current ?? "";
    for (;;) {
      const entered = await ask(
        p.text({
          ...io,
          message: "Folder the assistant may upload local files from (relative paths start here)",
          placeholder: "e.g. ./uploads or ~/shopify-uploads",
          initialValue: suggestion,
          validate: (value) => {
            if (!value?.trim()) return "Enter a folder";
            if (pathKind(resolveFolder(cwd, value.trim())) === "file") return "That's a file, not a folder";
            return undefined;
          },
        })
      );
      const folder = resolveFolder(cwd, entered.trim());
      if (pathKind(folder) === "folder") return folder;
      const create = await ask(
        p.confirm({ ...io, message: `${folder} doesn't exist yet. Create it when saving?`, initialValue: true })
      );
      if (create) return folder;
      suggestion = entered;
    }
  };

  const askAdvanced = async (draft: AdvancedAnswers): Promise<AdvancedAnswers> => {
    const readOnly = await ask(
      p.confirm({ ...io, message: "Read-only mode? Only tools that read store data are available.", initialValue: draft.readOnly })
    );
    // Write tools are hidden in read-only mode, so their settings don't apply
    let allowLiveThemeWrites = false;
    let uploadDir = draft.uploadDir;
    if (!readOnly) {
      allowLiveThemeWrites = await ask(
        p.confirm({
          ...io,
          message: "Allow edits to the live (published) theme? Otherwise the assistant edits a copy.",
          initialValue: draft.allowLiveThemeWrites,
        })
      );
      uploadDir = await askUploadDir(draft.uploadDir);
    }
    const picked = await ask(
      p.multiselect<Toolset>({
        ...io,
        message: "Toolsets to register",
        options: TOOLSETS.map((name) => ({ value: name, label: name })),
        initialValues: draft.toolsets ?? [...TOOLSETS],
        maxItems: TOOLSETS.length,
        required: true,
      })
    );
    const toolsets = TOOLSETS.filter((name) => picked.includes(name));
    const disableRawGraphql = await ask(
      p.confirm({
        ...io,
        message: "Turn off raw GraphQL (shopify_graphql)? Then only the selected toolsets can reach the store.",
        initialValue: draft.disableRawGraphql,
      })
    );
    return {
      readOnly,
      allowLiveThemeWrites,
      uploadDir,
      toolsets: toolsets.length === TOOLSETS.length ? undefined : toolsets,
      disableRawGraphql,
    };
  };

  // Describes the live theme, which CLAUDE.md says Claude edits
  const describeLiveTheme = (info: StoreInfo | undefined) => {
    if (!info) return;
    const live = info.liveTheme;
    if (live?.themeName === "Horizon") {
      p.log.info(`The live theme is Horizon ${live.version ?? "(version unknown)"}, "${live.name}".`, io);
    } else if (live) {
      p.log.warn(
        `The live theme is "${live.name}", not Horizon. CLAUDE.md expects a live Horizon theme, so its live theme line is left for you to fill in.`,
        io
      );
    } else {
      p.log.warn(
        `Couldn't read the live theme (${info.liveThemeError ?? "no reason given"}), so CLAUDE.md's live theme line is left for you to fill in. The app needs the read_themes scope.`,
        io
      );
    }
  };

  // A Horizon project: the theme from Shopify, and CLAUDE.md, THEME.md and customizations.md from the template
  const askProject = async (info: StoreInfo | undefined): Promise<ProjectAnswer | undefined> => {
    const themeDir = path.join(cwd, THEME_DIR);
    const kind = pathKind(themeDir);
    if (kind === "file") {
      p.log.warn(`${themeDir} is a file, so setup can't set up a Horizon theme project here.`, io);
      return undefined;
    }
    const wanted = await ask(
      p.confirm({
        ...io,
        message: `Set up a Horizon theme project here? (./${THEME_DIR} from Shopify, plus CLAUDE.md, THEME.md and customizations.md)`,
        initialValue: false,
      })
    );
    if (!wanted) return undefined;
    describeLiveTheme(info);

    const listing = p.spinner(io);
    listing.start("Getting Horizon versions from GitHub");
    const [themes, docs] = await Promise.allSettled([options.listHorizonVersions(), options.listDocsVersions()]);
    const versions = themes.status === "fulfilled" ? themes.value : [];
    if (versions.length === 0) {
      const reason = themes.status === "rejected" ? errorMessage(themes.reason) : "GitHub listed none";
      listing.error(`Couldn't get Horizon versions: ${reason}. Run setup again to retry.`);
      return undefined;
    }
    listing.stop(`Found ${versions.length} Horizon versions`);
    const docsVersions = docs.status === "fulfilled" ? docs.value : [];
    if (docs.status === "rejected") p.log.warn(`Couldn't list the project docs: ${errorMessage(docs.reason)}`, io);

    const liveVersion = info?.liveTheme?.themeName === "Horizon" ? info.liveTheme.version : undefined;
    const picked = await ask(
      p.select({
        ...io,
        message: "Which Horizon version?",
        maxItems: 8,
        initialValue: versions.some((horizon) => horizon.version === liveVersion) ? liveVersion : versions[0]!.version,
        options: versions.map((horizon, i) => ({
          value: horizon.version,
          label: `v${horizon.version}`,
          hint: [i === 0 ? "latest" : "", horizon.version === liveVersion ? "live theme" : "", releaseDate(horizon.date)]
            .filter(Boolean)
            .join(", "),
        })),
      })
    );
    const horizon = versions.find((candidate) => candidate.version === picked)!;
    if (liveVersion && liveVersion !== horizon.version) {
      p.log.warn(`The live theme is Horizon ${liveVersion}, so ./${THEME_DIR} won't match it.`, io);
    }
    // Without a docs listing, the version's own tag is tried
    const docsVersion = docsVersionFor(horizon.version, docsVersions) ?? horizon.version;
    if (docsVersion !== horizon.version) {
      p.log.warn(
        `There's no THEME.md for Horizon ${horizon.version} yet, so the one for ${docsVersion} is used. Claude checks what it relies on against the theme (THEME.md §0.1).`,
        io
      );
    }

    const current = [
      kind === "folder" && readdirSync(themeDir).length > 0 ? `the files in ./${THEME_DIR}` : "",
      pathKind(path.join(cwd, "THEME.md")) === "file" ? "THEME.md" : "",
    ].filter(Boolean);
    const replace = current.length > 0;
    if (
      replace &&
      !(await ask(
        p.confirm({
          ...io,
          message: `Replace ${current.join(" and ")} with Horizon v${horizon.version}? Changes made there will be lost.`,
          initialValue: false,
        })
      ))
    ) {
      return undefined;
    }

    let storefrontPassword: string | undefined;
    if (info?.passwordProtected !== false) {
      const entered = await ask(
        p.password({
          ...io,
          message: info?.passwordProtected
            ? "The storefront has a password. What is it? It goes in CLAUDE.md (press Enter to skip)"
            : "Storefront password, if it has one, for CLAUDE.md (press Enter to skip)",
        })
      );
      storefrontPassword = (entered ?? "").trim() || undefined;
    }
    return { horizon, docsVersion, replace, storefrontPassword };
  };

  try {
    p.intro("Shopify Admin MCP setup", io);
    p.log.info(
      `${existing.hasFile ? "Updating" : "Creating"} ${file}${existing.hasServer ? "; current values are filled in" : ""}`,
      io
    );

    const checking = p.spinner(io);
    checking.start("Checking Node.js requirements");
    const devMcpNode = await options.checkDevMcpNode();
    checking.stop(`Node.js ${nodeVersion}`);
    for (const check of [adminNode, devMcpNode]) {
      (check.ok ? p.log.success : p.log.warn)(describeNode(check, nodeVersion), io);
    }

    let store = await askStore(existing.store ?? "");
    let auth = await askAuth(undefined);

    let info: StoreInfo | undefined;
    for (;;) {
      const verifying = p.spinner(io);
      verifying.start(`Checking the credentials with ${store}`);
      const check = await verify(store, auth);
      if (check.ok) {
        verifying.stop(`Connected to ${check.shopName}`);
        info = check;
        break;
      }
      verifying.error(`Couldn't connect: ${check.message}`);
      const next = await ask(
        p.select({
          ...io,
          message: "What next?",
          options: [
            { value: "retry", label: "Re-enter the store and credentials" },
            { value: "continue", label: "Continue anyway" },
            { value: "cancel", label: "Cancel" },
          ],
        })
      );
      if (next === "continue") break;
      if (next === "cancel") throw new Cancelled();
      store = await askStore(store);
      auth = await askAuth(auth);
    }

    const project = await askProject(info);

    let includeDevMcp: boolean;
    let advanced: AdvancedAnswers | undefined;
    if (project) {
      // The settings CLAUDE.md describes
      includeDevMcp = true;
      advanced = {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: resolveFolder(cwd, UPLOADS_FOLDER),
        toolsets: undefined,
        disableRawGraphql: false,
      };
      p.log.info(
        "CLAUDE.md has Claude edit the live theme, upload files from ./uploads and check code with the Shopify Dev MCP, so those are switched on.",
        io
      );
      if (!devMcpNode.ok) {
        p.log.warn(`The Shopify Dev MCP won't start on ${nodeVersion} until you upgrade Node.js.`, io);
      }
    } else {
      if (!devMcpNode.ok) {
        p.log.warn(`The Shopify Dev MCP won't start on ${nodeVersion} until you upgrade Node.js.`, io);
      }
      includeDevMcp = await ask(
        p.confirm({
          ...io,
          message: "Also add the Shopify Dev MCP server? (Shopify docs search and GraphQL validation)",
          // An entry that's already there stays the default; the editor may run servers with another Node.js
          initialValue: existing.hasDevMcp || (!existing.hasFile && devMcpNode.ok),
        })
      );
      advanced = (await ask(
        p.confirm({
          ...io,
          message: "Configure advanced settings? (read-only, live theme writes, upload folder, toolsets, raw GraphQL)",
          initialValue: false,
        })
      ))
        ? await askAdvanced(existing.advanced)
        : undefined;
    }

    const devMcpChange = includeDevMcp
      ? existing.hasDevMcp ? "kept" : "added"
      : existing.hasDevMcp ? "removed" : "not included";
    p.note(
      [
        `File: ${file} (${existing.hasFile ? "update" : "new"})`,
        `Server: ${existing.serverName}`,
        `Store: ${store}`,
        `Authentication: ${AUTH_LABELS[auth.mode]}`,
        `Shopify Dev MCP: ${devMcpChange}`,
        `Advanced: ${advanced ? describeAdvanced(advanced) : existing.hasServer ? "unchanged" : "defaults"}`,
        ...(project
          ? [
              `Horizon project: v${project.horizon.version} into ./${THEME_DIR}, docs for ${project.docsVersion}${project.replace ? ", replacing current files" : ""}`,
            ]
          : []),
      ].join("\n"),
      "Summary",
      io
    );
    p.log.message(
      `The ${auth.mode === "access-token" ? "token" : "client secret"} is saved in plain text, readable only by you, and ${CONFIG_FILE} is added to .gitignore when this folder is a git repo.`,
      io
    );
    if (!(await ask(p.confirm({ ...io, message: `Save ${CONFIG_FILE}?`, initialValue: true })))) {
      throw new Cancelled();
    }

    const saving = p.spinner(io);
    saving.start(`Saving ${CONFIG_FILE}`);
    let result: SaveResult;
    try {
      result = await save({ store, auth, includeDevMcp, advanced });
    } catch (err) {
      saving.error(`Couldn't save ${CONFIG_FILE}: ${errorMessage(err)}`);
      return "failed";
    }
    saving.stop(`Saved ${result.path}`);

    if (result.createdUploadDir) p.log.info(`Created the upload folder ${result.createdUploadDir}`, io);
    if (result.gitignore === "added") p.log.info(`Added ${CONFIG_FILE} to .gitignore, so the credentials stay out of git.`, io);
    if (result.gitignore === "already-ignored") p.log.info(`${CONFIG_FILE} is already ignored by git.`, io);
    if (result.gitignore === "git-unavailable") {
      p.log.warn(`Couldn't run git to check .gitignore. Make sure ${CONFIG_FILE} isn't committed.`, io);
    }
    if (result.tracked) {
      p.log.warn(
        `${CONFIG_FILE} is already committed. Run \`git rm --cached ${CONFIG_FILE}\` and commit, so the credentials aren't pushed.`,
        io
      );
    }

    let complete = true;
    if (project) {
      const downloading = p.spinner(io);
      downloading.start(`Downloading Horizon v${project.horizon.version}`);
      try {
        const download = await options.downloadHorizon(project.horizon);
        downloading.stop(`Downloaded Horizon v${project.horizon.version} into ${download.dir} (${download.files} files)`);
      } catch (err) {
        complete = false;
        downloading.error(`Couldn't download Horizon: ${errorMessage(err)}`);
      }

      const live = info?.liveTheme;
      const details: ProjectDetails = {
        store,
        devStore: info?.devStore,
        liveTheme: live?.themeName === "Horizon" ? { id: live.id, version: live.version } : undefined,
        passwordProtected: info?.passwordProtected,
        storefrontPassword: project.storefrontPassword,
      };
      const writing = p.spinner(io);
      writing.start("Writing CLAUDE.md, THEME.md and customizations.md");
      try {
        const docs = await options.writeProjectDocs({
          docsVersion: project.docsVersion,
          replaceThemeMd: project.replace,
          details,
        });
        writing.stop(
          `Project docs for Horizon ${project.docsVersion}: ${docs.files.map((doc) => `${doc.name} ${doc.action}`).join(", ")}`
        );
        if (docs.placeholdersLeft) {
          p.log.warn("CLAUDE.md still has [agent: …] placeholders. Ask Claude to fill them in.", io);
        }
      } catch (err) {
        complete = false;
        writing.error(`Couldn't write the project docs: ${errorMessage(err)}`);
      }
      if (!complete) p.log.warn(`${CONFIG_FILE} is saved. Run setup again to finish the Horizon project.`, io);
    }
    p.outro("Restart Claude Code in this folder (or run /mcp) to connect.", io);
    return complete ? "saved" : "failed";
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    p.cancel(`Cancelled. ${CONFIG_FILE} wasn't changed.`, io);
    return "cancelled";
  }
}
