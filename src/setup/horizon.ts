import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { fetchArchive, githubApi } from "./github.js";

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

/**
 * Lists Horizon's versions, newest first. Horizon has no GitHub releases or tags: Shopify publishes
 * each version as a commit titled "Horizon vX.Y.Z" that bumps config/settings_schema.json.
 */
export async function listHorizonVersions(): Promise<HorizonVersion[]> {
  const commits = await githubApi<Commit[]>(`repos/${REPO}/commits?path=config/settings_schema.json&per_page=100`);
  const versions = new Map<string, HorizonVersion>();
  for (const { sha, commit } of commits) {
    const version = /^Horizon v(\d+\.\d+\.\d+)\s*$/.exec(commit.message.split("\n")[0]!)?.[1];
    // Commits come newest first, so a version released twice keeps its latest commit
    if (version && !versions.has(version)) versions.set(version, { version, sha, date: commit.committer.date });
  }
  return [...versions.values()].sort((a, b) => semver.rcompare(a.version, b.version));
}

/**
 * Downloads a Horizon version into <dir>/theme, replacing what's there. It unpacks into a
 * temporary folder first, so a failed download leaves an existing theme folder alone.
 */
export async function downloadHorizon(dir: string, horizon: HorizonVersion): Promise<DownloadResult> {
  const files = await fetchArchive(REPO, horizon.sha);
  if (files.length === 0) throw new Error("The download had no files");

  const target = path.join(dir, THEME_DIR);
  const staging = await mkdtemp(path.join(dir, `.${THEME_DIR}-download-`));
  try {
    for (const file of files) {
      const destination = path.join(staging, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { dir: target, files: files.length };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}
