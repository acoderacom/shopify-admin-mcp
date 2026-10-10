import { gunzipSync } from "node:zlib";
import { PACKAGE_NAME } from "./mcp-config.js";

/** Fetches from GitHub without a login, explaining its rate limit when it's hit. */
export async function githubFetch(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": PACKAGE_NAME, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok) return res;
  // Without a login, GitHub allows 60 API requests an hour from one IP address
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("GitHub's rate limit was reached, so try again in an hour");
  }
  throw new Error(`GitHub returned ${res.status}`);
}

/** Calls the GitHub REST API. */
export async function githubApi<T>(path: string): Promise<T> {
  const res = await githubFetch(`https://api.github.com/${path}`, 10_000, { accept: "application/vnd.github+json" });
  return (await res.json()) as T;
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
function relativePath(entryPath: string): string | undefined {
  const parts = entryPath.split("/").slice(1).filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  if (parts.some((part) => part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`The archive has an unexpected path: ${entryPath}`);
  }
  return parts.join("/");
}

/**
 * Downloads a repository at a commit or tag and returns its files, with paths relative to the
 * repository root.
 */
export async function fetchArchive(repo: string, ref: string): Promise<TarFile[]> {
  const res = await githubFetch(`https://github.com/${repo}/archive/${ref}.tar.gz`, 120_000);
  const files: TarFile[] = [];
  for (const file of readTar(gunzipSync(Buffer.from(await res.arrayBuffer())))) {
    const relative = relativePath(file.path);
    if (relative) files.push({ path: relative, data: file.data });
  }
  return files;
}
