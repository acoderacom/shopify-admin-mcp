import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import * as p from "@clack/prompts";
import { isValidStore, normalizeStore } from "../utils/cli.js";
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
import {
  TEMPLATE_REPO,
  checkLiveTheme,
  type ProjectDetails,
  type ProjectDocsInput,
  type ProjectDocsResult,
  type TemplateIndex,
} from "./template.js";
import type { StoreInfo, VerifyResult } from "./verify.js";

/** "stopped" means setup ended without writing anything, because a Horizon project couldn't be set up. */
export type SetupOutcome = "saved" | "cancelled" | "stopped" | "failed";

export interface WizardOptions {
  cwd: string;
  existing: ExistingSetup;
  /** The running Node.js version, e.g. v24.15.0. */
  nodeVersion: string;
  adminNode: NodeCheck;
  checkDevMcpNode: () => Promise<NodeCheck>;
  verify: (store: string, auth: AuthAnswers) => Promise<VerifyResult>;
  save: (answers: SetupAnswers) => Promise<SaveResult>;
  /** Reads the template's versions.json. */
  loadTemplateIndex: () => Promise<TemplateIndex>;
  /** Downloads Horizon into the theme folder, replacing what's there. */
  downloadHorizon: (horizon: HorizonVersion) => Promise<DownloadResult>;
  /** Saves an upload-ready zip of a Horizon version in the folder and returns its path. */
  saveHorizonZip: (horizon: HorizonVersion) => Promise<string>;
  writeProjectDocs: (input: ProjectDocsInput) => Promise<ProjectDocsResult>;
  /** Streams the prompts use instead of the terminal, for tests. */
  input?: Readable;
  output?: Writable;
}

// The folder theme design lets local uploads come from, as CLAUDE.md describes
const UPLOADS_FOLDER = "uploads";

const AUTH_LABELS: Record<AuthAnswers["mode"], string> = {
  "access-token": "Access token",
  "client-credentials": "Client ID and secret",
};

class Cancelled extends Error {}
// Ends setup without writing anything, after saying why
class Stopped extends Error {}

type Mode = "connect" | "theme";

const MODE_LABELS: Record<Mode, string> = {
  connect: "Connect to a store only",
  theme: "Full theme design",
};

interface ProjectAnswer {
  /** The live theme's version, which ./theme and THEME.md get too. */
  horizon: HorizonVersion;
  /** Whether the theme folder has files or THEME.md exists, which the project replaces. */
  replace: boolean;
  storefrontPassword?: string;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function pathKind(target: string): "folder" | "file" | "missing" {
  try {
    return statSync(target).isDirectory() ? "folder" : "file";
  } catch {
    return "missing";
  }
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
          { value: "access-token", label: AUTH_LABELS["access-token"], hint: "legacy custom app" },
          { value: "client-credentials", label: AUTH_LABELS["client-credentials"], hint: "dev dashboard app" },
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

  // Theme design: the theme from Shopify, and CLAUDE.md, THEME.md and customizations.md from the
  // template. Its versions.json is read first, so a problem shows before any store questions.
  const checkTemplate = async (): Promise<TemplateIndex> => {
    const themeDir = path.join(cwd, THEME_DIR);
    if (pathKind(themeDir) === "file") {
      p.log.warn(`${themeDir} is a file, so setup can't put the Horizon theme there. Move it, then run setup again.`, io);
      throw new Stopped();
    }
    const reading = p.spinner(io);
    reading.start("Checking the template on GitHub");
    let index: TemplateIndex;
    try {
      index = await options.loadTemplateIndex();
    } catch (err) {
      reading.error(`Couldn't read the template's versions from ${TEMPLATE_REPO}: ${errorMessage(err)}. Run setup again to retry.`);
      throw new Stopped();
    }
    const versions =
      index.supported.length === 1
        ? index.current.version
        : index.supported.map(({ version }) => (version === index.current.version ? `${version} (current)` : version)).join(", ");
    reading.stop(`Template: Horizon ${versions} (${TEMPLATE_REPO})`);
    return index;
  };

  // The Shopify theme store only installs the newest Horizon, so a store gets a specific version by uploading it
  const offerZip = async (horizon: HorizonVersion) => {
    p.log.info(
      `The Shopify theme store only installs the newest Horizon. To put Horizon ${horizon.version} on the store, upload it in the Shopify admin (Online Store → Themes → Add theme → Upload zip file) and publish it.`,
      io
    );
    const wanted = await ask(
      p.confirm({ ...io, message: `Save horizon-${horizon.version}.zip in this folder to upload?`, initialValue: true })
    );
    if (!wanted) return;
    const saving = p.spinner(io);
    saving.start(`Downloading Horizon ${horizon.version}`);
    try {
      saving.stop(`Saved ${await options.saveHorizonZip(horizon)}`);
    } catch (err) {
      saving.error(`Couldn't save the zip: ${errorMessage(err)}`);
    }
  };

  // After the credentials check. The live theme must be a supported Horizon version, or setup stops.
  const askProject = async (info: StoreInfo | undefined, index: TemplateIndex): Promise<ProjectAnswer> => {
    const themeDir = path.join(cwd, THEME_DIR);
    const live = info?.liveTheme;
    const check = checkLiveTheme(live, info ? (info.liveThemeError ?? "no reason given") : "the credentials check didn't pass", index);
    const name = live ? ` "${live.name}"` : "";
    if (check.status === "unknown") {
      p.log.warn(
        `Couldn't read the live theme (${check.reason}), so setup can't check it's a Horizon version the template supports. The app needs the read_themes scope; then run setup again.`,
        io
      );
      throw new Stopped();
    }
    if (check.status !== "match") {
      const target = check.current.version;
      const notice =
        check.status === "not-horizon"
          ? `The live theme${name} isn't Horizon. Switch the store to Horizon ${target}, then run setup again.`
          : check.status === "older"
            ? `The live theme${name} is Horizon ${check.version}, older than the template's Horizon ${target}. Switch the store to Horizon ${target}, then run setup again.`
            : `The live theme${name} is Horizon ${check.version}, newer than the template's Horizon ${target}. Switch the store to Horizon ${target}, or wait until the template supports ${check.version}, then run setup again.`;
      p.log.warn(notice, io);
      await offerZip(check.current);
      throw new Stopped();
    }
    const horizon = check.horizon;
    p.log.success(`The live theme${name} is Horizon ${horizon.version}, which matches the template.`, io);

    const current = [
      pathKind(themeDir) === "folder" && readdirSync(themeDir).length > 0 ? `the files in ./${THEME_DIR}` : "",
      pathKind(path.join(cwd, "THEME.md")) === "file" ? "THEME.md" : "",
    ].filter(Boolean);
    const replace = current.length > 0;
    if (
      replace &&
      !(await ask(
        p.confirm({
          ...io,
          message: `Replace ${current.join(" and ")} with Horizon ${horizon.version}? Changes made there will be lost.`,
          initialValue: false,
        })
      ))
    ) {
      throw new Cancelled();
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
    return { horizon, replace, storefrontPassword };
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

    // A folder that already has a theme was most likely set up for theme development
    const themeProject = pathKind(path.join(cwd, THEME_DIR)) === "folder" || pathKind(path.join(cwd, "THEME.md")) === "file";
    const mode = await ask(
      p.select<Mode>({
        ...io,
        message: "What do you want to set up?",
        initialValue: themeProject ? "theme" : "connect",
        options: [
          { value: "connect", label: MODE_LABELS.connect, hint: ".mcp.json for Claude Code, without theme edits" },
          {
            value: "theme",
            label: MODE_LABELS.theme,
            hint: `Horizon in ./${THEME_DIR}, plus CLAUDE.md, THEME.md and customizations.md`,
          },
        ],
      })
    );
    const index = mode === "theme" ? await checkTemplate() : undefined;

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
            // Theme development needs the live theme, so it can't go on without the store
            ...(mode === "connect" ? [{ value: "continue", label: "Continue anyway" }] : []),
            { value: "cancel", label: "Cancel" },
          ],
        })
      );
      if (next === "continue") break;
      if (next === "cancel") throw new Cancelled();
      store = await askStore(store);
      auth = await askAuth(auth);
    }

    const project = index ? await askProject(info, index) : undefined;

    let includeDevMcp: boolean;
    let advanced: AdvancedAnswers | undefined;
    if (project) {
      // The settings CLAUDE.md describes
      includeDevMcp = true;
      advanced = {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: path.join(cwd, UPLOADS_FOLDER),
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
    }

    const devMcpChange = includeDevMcp
      ? existing.hasDevMcp ? "kept" : "added"
      : existing.hasDevMcp ? "removed" : "not included";
    p.note(
      [
        `Mode: ${MODE_LABELS[mode]}`,
        `File: ${file} (${existing.hasFile ? "update" : "new"})`,
        `Server: ${existing.serverName}`,
        `Store: ${store}`,
        `Authentication: ${AUTH_LABELS[auth.mode]}`,
        `Shopify Dev MCP: ${devMcpChange}`,
        `Theme edits: ${mode === "connect" ? "off" : "on, including the live theme"}`,
        // Connecting to a store only keeps other settings already in the file, minus live theme writes
        `Settings: ${describeAdvanced(advanced ?? { ...existing.advanced, allowLiveThemeWrites: false })}`,
        ...(project
          ? [
              `Horizon project: Horizon ${project.horizon.version} in ./${THEME_DIR}, with its THEME.md${project.replace ? ", replacing current files" : ""}`,
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
      result = await save({ store, auth, includeDevMcp, advanced, disableThemeWrites: mode === "connect" });
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
      downloading.start(`Downloading Horizon ${project.horizon.version}`);
      try {
        const download = await options.downloadHorizon(project.horizon);
        downloading.stop(`Downloaded Horizon ${project.horizon.version} into ${download.dir} (${download.files} files)`);
      } catch (err) {
        complete = false;
        downloading.error(`Couldn't download Horizon: ${errorMessage(err)}`);
      }

      const live = info?.liveTheme;
      const details: ProjectDetails = {
        store,
        horizonVersion: project.horizon.version,
        devStore: info?.devStore,
        liveTheme: live?.themeName === "Horizon" ? { id: live.id, version: live.version } : undefined,
        passwordProtected: info?.passwordProtected,
        storefrontPassword: project.storefrontPassword,
      };
      const writing = p.spinner(io);
      writing.start("Writing CLAUDE.md, THEME.md and customizations.md");
      try {
        const docs = await options.writeProjectDocs({ replaceThemeMd: project.replace, details });
        writing.stop(
          `Project docs for Horizon ${project.horizon.version}: ${docs.files.map((doc) => `${doc.name} ${doc.action}`).join(", ")}`
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
    if (err instanceof Stopped) {
      p.cancel(`Setup stopped. ${CONFIG_FILE} wasn't changed.`, io);
      return "stopped";
    }
    if (!(err instanceof Cancelled)) throw err;
    p.cancel(`Cancelled. ${CONFIG_FILE} wasn't changed.`, io);
    return "cancelled";
  }
}
