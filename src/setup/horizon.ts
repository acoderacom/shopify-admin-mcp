import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchArchive } from "./github.js";
import { createZip } from "./zip.js";

const REPO = "Shopify/horizon";

/** The folder in the project that Horizon is downloaded into. */
export const THEME_DIR = "theme";

/** A Horizon version and the Shopify/horizon commit that holds it. */
export interface HorizonVersion {
  version: string;
  sha: string;
}

export interface DownloadResult {
  dir: string;
  files: number;
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

/**
 * Saves a Horizon version as <dir>/horizon-<version>.zip with the theme folders at the top level,
 * ready for Online Store → Themes → Add theme → Upload zip file. The Shopify theme store only
 * installs the newest Horizon, so this is how a store gets a specific version.
 */
export async function saveHorizonZip(dir: string, horizon: HorizonVersion): Promise<string> {
  const files = await fetchArchive(REPO, horizon.sha);
  if (!files.some((file) => file.path === "layout/theme.liquid")) {
    throw new Error("The download has no layout/theme.liquid, so it isn't a theme");
  }
  const target = path.join(dir, `horizon-${horizon.version}.zip`);
  const staging = `${target}.part`;
  await writeFile(staging, createZip(files));
  await rename(staging, target);
  return target;
}
