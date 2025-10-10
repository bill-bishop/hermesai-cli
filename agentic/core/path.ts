import fs from "fs";
import path from "node:path";

export const PROJECT_ROOT = path.resolve(process.cwd());
export const REAL_PROJECT_ROOT = await fs.promises.realpath(PROJECT_ROOT).catch(() => PROJECT_ROOT);

export async function resolveInsideRoot(userPath: string = ".") {
  // Strip any drive letter / leading slash
  if (path.isAbsolute(userPath)) userPath = path.relative(path.parse(userPath).root, userPath);

  // Normalize relative to project root
  const absPath = path.resolve(PROJECT_ROOT, userPath);
  const rel = path.relative(PROJECT_ROOT, absPath);

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${userPath}`);
  }

  // Symlink-aware check
  const realAbs = await fs.promises.realpath(absPath).catch(() => absPath);
  const realRel = path.relative(REAL_PROJECT_ROOT, realAbs);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`Symlink escape: ${userPath}`);
  }

  // Return both absolute + project-relative for later use
  return { abs: realAbs, rel: path.relative(PROJECT_ROOT, realAbs) };
}
