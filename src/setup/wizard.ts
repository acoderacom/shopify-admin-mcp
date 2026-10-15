import { readFileSync, readdirSync, statSync } from "node:fs";
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
import { REDIRECT_URI, type ApprovalInput, type ApprovalResult } from "./oauth.js";
import {
  TEMPLATE_REPO,
  checkLiveTheme,
  claudeMdKind,
  type ProjectDetails,
  type ProjectDocsInput,
  type ProjectDocsResult,
  type TemplateIndex,
} from "./template.js";
import type { StoreInfo, StoreTheme, VerifyResult } from "./verify.js";

/** "stopped" means setup ended without writing anything, because a theme project couldn't be set up. */
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
  /** Waits for the user to approve the app in the browser and returns its access token; onUrl gets the approval page. */
  approveInBrowser: (input: ApprovalInput, onUrl: (url: string) => void) => Promise<ApprovalResult>;
  openInBrowser: (url: string) => void;
  /** Creates the theme folder for a live-site project, emptying it first when asked. */
  prepareThemeDir: (empty: boolean) => Promise<void>;
  /** Streams the prompts use instead of the terminal, for tests. */
  input?: Readable;
  output?: Writable;
}

// The folder local uploads come from in both modes, as CLAUDE.md describes for theme design
const UPLOADS_FOLDER = "uploads";

const AUTH_LABELS: Record<AuthAnswers["mode"], string> = {
  "access-token": "Access token",
  "client-credentials": "Client ID and secret",
};
// The client credentials grant only works on stores in the app's own organization; elsewhere the
// user approves the app in the browser and setup saves the access token that gives
type AuthChoice = AuthAnswers["mode"] | "browser";
const BROWSER_APPROVAL = "Client ID and secret, approved in the browser";

class Cancelled extends Error {}
// Ends setup without writing anything, after saying why
class Stopped extends Error {}

type Mode = "connect" | "theme" | "other";

const MODE_LABELS: Record<Mode, string> = {
  connect: "Connect to a store only",
  theme: "Full theme design with Horizon",
  other: "Full theme edit live site",
};

type ProjectAnswer =
  | {
      kind: "horizon";
      /** The live theme's version, which ./theme and THEME.md get too. */
      horizon: HorizonVersion;
      /** Whether the theme folder has files or THEME.md exists, which the project replaces. */
      replace: boolean;
      storefrontPassword?: string;
    }
  | {
      kind: "other";
      /** An unpublished copy the user made; the live theme can't be picked. */
      theme: StoreTheme;
      /** Whether to empty ./theme and start THEME.md blank again. */
      reset: boolean;
      storefrontPassword?: string;
    };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function pathKind(target: string): "folder" | "file" | "missing" {
  try {
    return statSync(target).isDirectory() ? "folder" : "file";
  } catch {
    return "missing";
  }
}

function readText(target: string): string | undefined {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function describeTheme(theme: StoreTheme): string {
  const stock = [theme.themeName, theme.version].filter(Boolean).join(" ");
  const role = theme.role === "MAIN" ? "live theme" : theme.role === "DEVELOPMENT" ? "development theme" : "unpublished";
  return `${theme.name}: ${stock ? `${stock}, ` : ""}${role}`;
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
  if (advanced.themeDir) parts.push(`theme files from ${advanced.themeDir}`);
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

  // Set when the access token came from approving the app in the browser
  let approvedInBrowser = false;

  const askApproval = async (store: string): Promise<AuthAnswers> => {
    p.note(
      [
        "For an app installed on a store outside the app's organization, where the client ID and secret alone are refused.",
        "1. In the Dev Dashboard, add this redirect URL to the app's version, then release the version:",
        `   ${REDIRECT_URI}`,
        "2. Setup opens Shopify's approval page; approve the app there.",
        `The client secret is only used for the approval and isn't saved: ${CONFIG_FILE} gets the access token.`,
      ].join("\n"),
      "Approve in the browser",
      io
    );
    const clientId = (
      await ask(
        p.text({
          ...io,
          message: "Client ID",
          initialValue: existing.clientId ?? "",
          validate: (value) => (value?.trim() ? undefined : "Enter the client ID"),
        })
      )
    ).trim();
    const clientSecret = await askSecret("Client secret", existing.clientSecret ?? "");
    const scopes = (
      await ask(
        p.text({
          ...io,
          message: "Access scopes to request, comma-separated (press Enter for the scopes on the app's version)",
          placeholder: "read_themes,write_themes,read_products",
        })
      )
    ) ?? "";
    for (;;) {
      if (!(await ask(p.confirm({ ...io, message: "Redirect URL added and the version released? Open the approval page", initialValue: true })))) {
        throw new Cancelled();
      }
      try {
        const result = await options.approveInBrowser({ store, clientId, clientSecret, scopes: scopes.trim() }, (url) => {
          p.log.info(`Opening Shopify's approval page. If it doesn't open, go to:\n${url}`, io);
          options.openInBrowser(url);
          p.log.message("Waiting for the approval (up to 5 minutes)...", io);
        });
        approvedInBrowser = true;
        p.log.success(`Approved. Scopes granted: ${result.scope || "none listed"}`, io);
        return { mode: "access-token", accessToken: result.accessToken };
      } catch (err) {
        p.log.error(`Couldn't get the approval: ${errorMessage(err)}`, io);
      }
    }
  };

  const askAuth = async (store: string, current: AuthAnswers | undefined): Promise<AuthAnswers> => {
    const choice = await ask(
      p.select<AuthChoice>({
        ...io,
        message: "How does the app authenticate?",
        initialValue: approvedInBrowser ? "browser" : (current?.mode ?? existing.authMode ?? "access-token"),
        options: [
          { value: "access-token", label: AUTH_LABELS["access-token"] },
          { value: "client-credentials", label: AUTH_LABELS["client-credentials"] },
          { value: "browser", label: BROWSER_APPROVAL },
        ],
      })
    );
    approvedInBrowser = false;
    if (choice === "browser") return askApproval(store);
    const mode = choice;
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
  const themeDir = path.join(cwd, THEME_DIR);
  const themeDirHasFiles = () => pathKind(themeDir) === "folder" && readdirSync(themeDir).length > 0;
  const claudeMd = readText(path.join(cwd, "CLAUDE.md"));
  const themeMd = readText(path.join(cwd, "THEME.md"));

  const askPassword = async (info: StoreInfo | undefined) => {
    if (info?.passwordProtected === false) return undefined;
    const entered = await ask(
      p.password({
        ...io,
        message: info?.passwordProtected
          ? "The storefront has a password. What is it? It goes in CLAUDE.md (press Enter to skip)"
          : "Storefront password, if it has one, for CLAUDE.md (press Enter to skip)",
      })
    );
    return (entered ?? "").trim() || undefined;
  };

  const askHorizonProject = async (info: StoreInfo | undefined, index: TemplateIndex): Promise<ProjectAnswer> => {
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
      themeDirHasFiles() ? `the files in ./${THEME_DIR}` : "",
      themeMd !== undefined ? "THEME.md" : "",
    ].filter(Boolean);
    const replace = current.length > 0;
    // CLAUDE.md written for a live site is replaced along with them
    if (claudeMd !== undefined && claudeMdKind(claudeMd) === "other") current.push("CLAUDE.md");
    if (
      current.length > 0 &&
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

    return { kind: "horizon", horizon, replace, storefrontPassword: await askPassword(info) };
  };

  // After the credentials check. The user picks one of the store's unpublished themes (never the live one),
  // downloads it into ./theme by hand, and asks Claude to write THEME.md from it when they want.
  const askOtherProject = async (info: StoreInfo | undefined): Promise<ProjectAnswer> => {
    if (pathKind(themeDir) === "file") {
      p.log.warn(`${themeDir} is a file, so setup can't make the theme folder there. Move it, then run setup again.`, io);
      throw new Stopped();
    }
    const themes = info?.themes ?? [];
    if (themes.length === 0) {
      const reason = info ? (info.themesError ?? "the store has none Claude can edit") : "the credentials check didn't pass";
      p.log.warn(`Couldn't list the store's themes (${reason}). The app needs the read_themes scope; then run setup again.`, io);
      throw new Stopped();
    }

    let reset = false;
    if (claudeMd !== undefined && claudeMdKind(claudeMd) === "horizon") {
      // Switching a Horizon project over: its CLAUDE.md, THEME.md and theme files describe Horizon
      const switching = await ask(
        p.confirm({
          ...io,
          message: `This folder is set up for Horizon. Switch it to editing a live site? CLAUDE.md is replaced, THEME.md starts blank and ./${THEME_DIR} is emptied; changes made there will be lost.`,
          initialValue: false,
        })
      );
      if (!switching) throw new Cancelled();
      reset = true;
    } else if (themeDirHasFiles() || themeMd?.trim()) {
      // Running setup again keeps the theme files and the THEME.md Claude wrote, unless asked
      reset = await ask(
        p.confirm({
          ...io,
          message: `Start over? ./${THEME_DIR} is emptied and THEME.md starts blank, for you to download the theme again and Claude to write THEME.md again. Changes made there will be lost.`,
          initialValue: false,
        })
      );
    }
    // Claude only ever edits a copy, which the user duplicates from the live theme and publishes themselves
    const copies = themes.filter((theme) => theme.role !== "MAIN");
    if (copies.length === 0) {
      p.log.warn(
        "The store has no unpublished theme for Claude to edit. Duplicate the live theme in the Shopify admin (Online Store → Themes → ⋯ → Duplicate), give the copy a name, then run setup again.",
        io
      );
      throw new Stopped();
    }
    // Running setup again keeps the theme CLAUDE.md names, unless it has since been published
    const previousId = claudeMd && /^- Theme to edit: .*ID (gid:\/\/shopify\/OnlineStoreTheme\/\d+)/m.exec(claudeMd)?.[1];
    const previous = themes.find((theme) => theme.id === previousId);
    if (previous?.role === "MAIN") {
      p.log.warn(`"${previous.name}", the theme CLAUDE.md names, is now the live theme, so pick a copy to edit.`, io);
    }
    const id = await ask(
      p.select<string>({
        ...io,
        message: "Which theme will Claude edit?",
        initialValue: previous?.role !== "MAIN" && previous ? previous.id : copies[0]!.id,
        // The live theme is listed but can't be picked; two copies can share a name and version, so those also show their ID
        options: themes.map((theme) => {
          const label = describeTheme(theme);
          const twin = themes.some((other) => other !== theme && describeTheme(other) === label);
          return theme.role === "MAIN"
            ? { value: theme.id, label: `${label}, can't be edited here`, disabled: true }
            : { value: theme.id, label: twin ? `${label}, ID ${theme.id.split("/").pop()}` : label };
        }),
      })
    );
    const theme = themes.find((candidate) => candidate.id === id)!;
    return { kind: "other", theme, reset, storefrontPassword: await askPassword(info) };
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

    // A folder that already has a theme was most likely set up for theme development, and its CLAUDE.md says which kind
    const themeProject = pathKind(themeDir) === "folder" || themeMd !== undefined;
    const initialMode: Mode =
      claudeMd !== undefined && claudeMdKind(claudeMd) === "other" ? "other" : themeProject ? "theme" : "connect";
    const mode = await ask(
      p.select<Mode>({
        ...io,
        message: "What do you want to set up?",
        initialValue: initialMode,
        options: (["connect", "theme", "other"] as const).map((value) => ({ value, label: MODE_LABELS[value] })),
      })
    );
    const index = mode === "theme" ? await checkTemplate() : undefined;

    let store = await askStore(existing.store ?? "");
    let auth = await askAuth(store, undefined);

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
      auth = await askAuth(store, auth);
    }

    const project =
      mode === "theme" ? await askHorizonProject(info, index!) : mode === "other" ? await askOtherProject(info) : undefined;

    let includeDevMcp: boolean;
    let advanced: AdvancedAnswers | undefined;
    if (project) {
      // The settings CLAUDE.md describes; a live-site project edits a copy, so the live theme stays out of reach
      const liveWrites = project.kind === "horizon";
      includeDevMcp = true;
      advanced = {
        readOnly: false,
        allowLiveThemeWrites: liveWrites,
        uploadDir: path.join(cwd, UPLOADS_FOLDER),
        themeDir: path.join(cwd, THEME_DIR),
        toolsets: undefined,
        disableRawGraphql: false,
      };
      p.log.info(
        liveWrites
          ? `CLAUDE.md has Claude edit the live theme from ./${THEME_DIR}, upload files from ./${UPLOADS_FOLDER} and check code with the Shopify Dev MCP, so those are switched on.`
          : `CLAUDE.md has Claude edit "${project.kind === "other" ? project.theme.name : ""}" from ./${THEME_DIR}, upload files from ./${UPLOADS_FOLDER} and check code with the Shopify Dev MCP, so those are switched on. Live theme writes stay off and themes are locked, so Claude can't change the live theme or create, duplicate, rename, delete or publish themes.`,
        io
      );
      if (!devMcpNode.ok) {
        p.log.warn(`The Shopify Dev MCP won't start on ${nodeVersion} until you upgrade Node.js.`, io);
      }
    } else {
      // Product images and other local files can only be uploaded from a folder set in the file
      if (!existing.advanced.uploadDir) {
        advanced = { ...existing.advanced, allowLiveThemeWrites: false, uploadDir: path.join(cwd, UPLOADS_FOLDER) };
        p.log.info(
          `Local files to upload to the store, such as product images, go in ./${UPLOADS_FOLDER}, so uploads from it are switched on.`,
          io
        );
      }
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
        `Authentication: ${approvedInBrowser ? "Access token, from approving the app in the browser" : AUTH_LABELS[auth.mode]}`,
        `Shopify Dev MCP: ${devMcpChange}`,
        `Theme edits: ${mode === "connect" ? "off" : mode === "other" ? "files of the chosen copy only; themes locked" : "on, including the live theme"}`,
        // Connecting to a store only keeps other settings already in the file, minus live theme writes
        `Settings: ${describeAdvanced(advanced ?? { ...existing.advanced, allowLiveThemeWrites: false })}`,
        ...(project?.kind === "horizon"
          ? [
              `Horizon project: Horizon ${project.horizon.version} in ./${THEME_DIR}, with its THEME.md${project.replace ? ", replacing current files" : ""}`,
            ]
          : []),
        ...(project?.kind === "other"
          ? [
              `Theme to edit: ${describeTheme(project.theme)}, ${project.theme.id}`,
              `Theme project: ./${THEME_DIR} for the theme you download, and THEME.md for Claude to write from it${project.reset ? `; ./${THEME_DIR} is emptied and THEME.md starts blank` : ""}`,
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
      result = await save({ store, auth, includeDevMcp, advanced, disableThemeWrites: mode === "connect", lockThemes: mode === "other" });
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
    if (project?.kind === "other") {
      try {
        await options.prepareThemeDir(project.reset);
        p.log.info(`${project.reset ? "Emptied" : "Ready:"} ./${THEME_DIR}, for the theme you download`, io);
      } catch (err) {
        complete = false;
        p.log.error(`Couldn't make ./${THEME_DIR}: ${errorMessage(err)}`, io);
      }
    }
    if (project?.kind === "horizon") {
      const downloading = p.spinner(io);
      downloading.start(`Downloading Horizon ${project.horizon.version}`);
      try {
        const download = await options.downloadHorizon(project.horizon);
        downloading.stop(`Downloaded Horizon ${project.horizon.version} into ${download.dir} (${download.files} files)`);
      } catch (err) {
        complete = false;
        downloading.error(`Couldn't download Horizon: ${errorMessage(err)}`);
      }

    }
    if (project) {
      const horizon = project.kind === "horizon";
      const live = info?.liveTheme;
      const details: ProjectDetails = {
        store,
        horizonVersion: horizon ? project.horizon.version : undefined,
        // A live-site project's CLAUDE.md always says "live store"
        devStore: horizon ? info?.devStore : undefined,
        // Another theme's live theme line is left for the user to fill in by hand
        liveTheme: horizon && live?.themeName === "Horizon" ? { id: live.id, version: live.version } : undefined,
        passwordProtected: info?.passwordProtected,
        storefrontPassword: project.storefrontPassword,
        editTheme: horizon
          ? undefined
          : {
              id: project.theme.id,
              name: project.theme.name,
              stock: [project.theme.themeName, project.theme.version].filter(Boolean).join(" ") || undefined,
            },
      };
      const writing = p.spinner(io);
      writing.start("Writing CLAUDE.md, THEME.md and customizations.md");
      try {
        const docs = await options.writeProjectDocs({
          kind: project.kind,
          replaceThemeMd: horizon ? project.replace : project.reset,
          details,
        });
        const list = docs.files.map((doc) => `${doc.name} ${doc.action}`).join(", ");
        writing.stop(horizon ? `Project docs for Horizon ${project.horizon.version}: ${list}` : `Project docs for the live site: ${list}`);
        if (docs.placeholdersLeft) {
          p.log.warn("CLAUDE.md still has [agent: …] placeholders. Ask Claude to fill them in.", io);
        }
      } catch (err) {
        complete = false;
        writing.error(`Couldn't write the project docs: ${errorMessage(err)}`);
      }
      if (!complete) p.log.warn(`${CONFIG_FILE} is saved. Run setup again to finish the theme project.`, io);
      if (!horizon && complete) {
        const name = project.theme.name;
        const download = themeDirHasFiles()
          ? `1. ./${THEME_DIR} already has files. If they aren't "${name}", empty it and copy that theme's files in again.`
          : `1. Copy the files of "${name}" into ./${THEME_DIR}: Shopify admin → Online Store → Themes → ⋯ on that theme → Download theme file (Shopify emails a link), then unzip it there.`;
        p.note(
          [
            download,
            "2. When you want Claude to learn the theme, ask it to: it writes THEME.md from ./theme. Until then THEME.md stays blank.",
          ].join("\n"),
          "Next, by hand",
          io
        );
      }
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
