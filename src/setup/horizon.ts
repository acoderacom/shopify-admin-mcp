import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import semver from "semver";
import { PACKAGE_NAME } from "./mcp-config.js";

const REPO = "Shopify/horizon";

/** The folder in the project that Horizon is downloaded into. */
export const THEME_DIR = "theme";

export interface HorizonVersion {
  version: string;
  /** The commit that released this version. */
  sha: string;
  /** When it was released, as an ISO timestamp. */
  date: string;
}

export interface DownloadResult {
  dir: string;
  files: number;
}

interface Commit {
  sha: string;
  commit: { message: string; committer: { date: string } };
}

async function github(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": PACKAGE_NAME, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok) return res;
  // Without a login, GitHub allows 60 API requests an hour from one IP address
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("GitHub's rate limit was reached, so try again in an hour");
  }
  throw new Error(`GitHub returned ${res.status}`);
}

/**
 * Lists Horizon's versions, newest first. Horizon has no GitHub releases or tags: Shopify publishes
 * each version as a commit titled "Horizon vX.Y.Z" that bumps config/settings_schema.json.
 */
export async function listHorizonVersions(): Promise<HorizonVersion[]> {
  const res = await github(
    `https://api.github.com/repos/${REPO}/commits?path=config/settings_schema.json&per_page=100`,
    10_000,
    { accept: "application/vnd.github+json" }
  );
  const versions = new Map<string, HorizonVersion>();
  for (const { sha, commit } of (await res.json()) as Commit[]) {
    const version = /^Horizon v(\d+\.\d+\.\d+)\s*$/.exec(commit.message.split("\n")[0]!)?.[1];
    // Commits come newest first, so a version released twice keeps its latest commit
    if (version && !versions.has(version)) versions.set(version, { version, sha, date: commit.committer.date });
  }
  return [...versions.values()].sort((a, b) => semver.rcompare(a.version, b.version));
}

export interface TarFile {
  path: string;
  data: Buffer;
}

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

// A pax extended header is a list of "<length> <key>=<value>\n" records
function paxValue(data: Buffer, key: string): string | undefined {
  let value: string | undefined;
  for (let offset = 0; offset < data.length; ) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString(), 10);
    if (space === -1 || !(length > 0)) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === key) value = record.slice(equals + 1);
    offset += length;
  }
  return value;
}

/** Reads the regular files from a tar archive like the ones GitHub serves (ustar, with pax headers). */
export function readTar(archive: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let longPath: string | undefined;
  for (let offset = 0; ; ) {
    if (offset + 512 > archive.length) throw new Error("The archive ended early");
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return files;

    // The checksum adds up every header byte, counting its own field as spaces
    let sum = 8 * 0x20;
    for (let i = 0; i < 512; i++) if (i < 148 || i >= 156) sum += header[i]!;
    if (sum !== Number.parseInt(text(header, 148, 8).trim(), 8)) throw new Error("The archive is damaged");

    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const start = offset + 512;
    if (start + size > archive.length) throw new Error("The archive ended early");
    const data = archive.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    if (type === "x") {
      longPath = paxValue(data, "path") ?? longPath;
      continue;
    }
    if (type === "L") {
      longPath = text(data, 0, data.length);
      continue;
    }
    // Global header: GitHub stores the commit there
    if (type === "g") continue;

    const name = text(header, 0, 100);
    const prefix = text(header, 257, 6) === "ustar" ? text(header, 345, 155) : "";
    const entryPath = longPath ?? (prefix ? `${prefix}/${name}` : name);
    longPath = undefined;
    // Only regular files: folders come from the file paths, and links are skipped
    if (type === "0" || type === "7") files.push({ path: entryPath, data });
  }
}

// GitHub puts everything in one top folder named after the repository and commit
function themePath(entryPath: string): string | undefined {
  const parts = entryPath.split("/").slice(1).filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  if (parts.some((part) => part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`The archive has an unexpected path: ${entryPath}`);
  }
  return parts.join("/");
}

/**
 * Downloads a Horizon version into <dir>/theme, replacing what's there. It unpacks into a
 * temporary folder first, so a failed download leaves an existing theme folder alone.
 */
export async function downloadHorizon(dir: string, horizon: HorizonVersion): Promise<DownloadResult> {
  const res = await github(`https://github.com/${REPO}/archive/${horizon.sha}.tar.gz`, 120_000);
  const files = readTar(gunzipSync(Buffer.from(await res.arrayBuffer())));

  const target = path.join(dir, THEME_DIR);
  const staging = await mkdtemp(path.join(dir, `.${THEME_DIR}-download-`));
  try {
    let count = 0;
    for (const file of files) {
      const relative = themePath(file.path);
      if (!relative) continue;
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
      count++;
    }
    if (count === 0) throw new Error("The download had no files");
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { dir: target, files: count };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}
