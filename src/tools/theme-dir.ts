import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Every theme file lives in one of these folders, so a filename outside them is a mistake or an attack
const THEME_FOLDERS = ["assets", "blocks", "config", "layout", "locales", "sections", "snippets", "templates"];

const DOWNLOAD_TIMEOUT_MS = 60_000;

// Shopify serves some file bodies as a URL; only its own hosts are fetched from
const SHOPIFY_HOSTS = [".shopify.com", ".myshopify.com", ".shopifycdn.com", ".shopifycdn.net"];

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ThemeFileBody = { type: "TEXT" | "BASE64"; value: string };

export interface RemoteBody {
  content?: string;
  contentBase64?: string;
  url?: string;
}

export function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

/** Text when the bytes are UTF-8 without NUL characters, otherwise base64, so the bytes Shopify stores are the bytes on disk. */
export function themeFileBody(data: Buffer): ThemeFileBody {
  if (!data.includes(0)) {
    try {
      return { type: "TEXT", value: utf8.decode(data) };
    } catch {
      // Not UTF-8, so it's sent as base64
    }
  }
  return { type: "BASE64", value: data.toString("base64") };
}

function checkFilename(filename: string): void {
  const parts = filename.split("/");
  if (filename.includes("\\") || filename.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${filename}" isn't a theme file path`);
  }
  if (parts.length < 2 || !THEME_FOLDERS.includes(parts[0]!)) {
    throw new Error(`"${filename}" isn't in a theme folder (${THEME_FOLDERS.join(", ")})`);
  }
}

async function themeRoot(themeDir: string): Promise<string> {
  try {
    return await realpath(themeDir);
  } catch {
    throw new Error(`The theme folder ${themeDir} doesn't exist`);
  }
}

const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/** Reads <themeDir>/<filename>, refusing anything that resolves outside the folder (symlinks included). */
export async function readThemeFile(themeDir: string, filename: string): Promise<Buffer> {
  checkFilename(filename);
  const root = await themeRoot(themeDir);
  let resolved: string;
  try {
    resolved = await realpath(path.join(root, filename));
  } catch {
    throw new Error(`${filename} isn't in the theme folder ${root}`);
  }
  if (!inside(root, resolved) || resolved === root) {
    throw new Error(`${filename} resolves outside the theme folder ${root}`);
  }
  if (!(await stat(resolved)).isFile()) throw new Error(`${filename} is not a file`);
  return readFile(resolved);
}

// The deepest folder on the way to `target` that already exists
async function nearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    const parent = path.dirname(current);
    try {
      await lstat(current);
      return current;
    } catch {
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Writes <themeDir>/<filename> atomically, refusing paths that resolve outside the folder.
 * A file whose bytes already match is left alone.
 */
export async function writeThemeFile(themeDir: string, filename: string, data: Buffer): Promise<"written" | "unchanged"> {
  checkFilename(filename);
  const root = await themeRoot(themeDir);
  const target = path.join(root, filename);
  const folder = path.dirname(target);

  // Check before creating folders, so a symlinked folder can't lead outside the theme folder
  if (!inside(root, await realpath(await nearestExisting(folder)))) {
    throw new Error(`${filename} resolves outside the theme folder ${root}`);
  }
  await mkdir(folder, { recursive: true });
  if (!inside(root, await realpath(folder))) {
    throw new Error(`${filename} resolves outside the theme folder ${root}`);
  }

  const existing = await lstat(target).catch(() => undefined);
  if (existing && !existing.isFile()) throw new Error(`${filename} is a symlink or folder, so it wasn't overwritten`);
  if (existing && (await readFile(target)).equals(data)) return "unchanged";

  const temp = path.join(folder, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return "written";
}

/** The bytes of a theme file body Shopify returned; URL bodies are downloaded from Shopify's own hosts. */
export async function remoteBytes(body: RemoteBody): Promise<Buffer> {
  if (body.content !== undefined) return Buffer.from(body.content, "utf8");
  if (body.contentBase64 !== undefined) return Buffer.from(body.contentBase64, "base64");
  if (!body.url) throw new Error("Shopify returned no content");

  const url = new URL(body.url);
  if (url.protocol !== "https:" || !SHOPIFY_HOSTS.some((host) => url.hostname.endsWith(host))) {
    throw new Error(`Shopify returned the content at ${url.host}, which isn't a Shopify host`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Downloading the content failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
