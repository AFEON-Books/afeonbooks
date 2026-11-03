import { execFileSync } from "node:child_process";
import fs from "fs/promises";
import path from "path";

const repoRoot = path.resolve(process.cwd(), "..", "..");
const targetArg = process.argv[2];
if (!targetArg) {
  console.error("Usage: node scripts/export_source.mjs <target-dir>");
  process.exit(1);
}

const target = path.resolve(process.cwd(), targetArg);
const targetRel = path.relative(repoRoot, target).replace(/\\/g, "/");
if (!/^artifacts\/[^/]+\/(?:public\/source|dist\/public\/source)$/.test(targetRel)) {
  throw new Error("Export target must be an artifact public/source directory.");
}

const excludeNames = new Set([".git", "node_modules", ".cache", "mm-ai-inst.txt"]);
const privateFileExtensions = new Set([
  ".bak",
  ".backup",
  ".csv",
  ".db",
  ".dump",
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3",
  ".sql",
  ".xls",
  ".xlsx",
]);
const exportableFiles = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean),
);

function normalizeRel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shouldExclude(filePath) {
  const rel = normalizeRel(filePath);
  const name = path.basename(filePath).toLowerCase();
  const extension = path.extname(name);
  if (!rel || rel === ".") return false;
  if (rel === targetRel || rel.startsWith(`${targetRel}/`)) return true;
  if (excludeNames.has(path.basename(filePath))) return true;
  if (
    name.startsWith(".env") ||
    name.includes("backup") ||
    name.includes("production-export") ||
    name === "zipfile.zip" ||
    (privateFileExtensions.has(extension) &&
      !(extension === ".sql" && rel.startsWith("lib/db/migrations/")))
  ) return true;
  if (rel.startsWith("dist/") || rel.startsWith("artifacts/") || rel.startsWith("public/source")) return true;
  if (rel.startsWith(".replit-artifact") || rel.startsWith("artifacts/")) {
    if (rel.includes("dist/public/source") || rel.includes("dist/public/assets") || rel.includes("dist/")) return true;
  }
  return false;
}

async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(src, entry.name);
      if (shouldExclude(srcPath)) return;

      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath);
      } else if (entry.isSymbolicLink()) {
        if (!exportableFiles.has(normalizeRel(srcPath))) return;
        const linkTarget = await fs.readlink(srcPath);
        await fs.symlink(linkTarget, destPath);
      } else if (entry.isFile() && exportableFiles.has(normalizeRel(srcPath))) {
        await fs.copyFile(srcPath, destPath);
      }
    })
  );
}

async function buildIndexHtml(rootTarget) {
  const entries = [];

  async function walkDir(dir, relativeDirectory = "") {
    const names = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of names) {
      const srcPath = path.join(dir, entry.name);
      const relPath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walkDir(srcPath, relPath);
      } else if (entry.isFile()) {
        entries.push(relPath);
      }
    }
  }

  await walkDir(rootTarget);
  entries.sort();

  const rows = entries
    .map((entry) => {
      const url = `/source/${entry.split("/").map(encodeURIComponent).join("/")}`;
      return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry)}</a></li>`;
    })
    .join("\n        ");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AFEON Books Source</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #f7f7f7; color: #111; }
    h1 { margin-bottom: 0.5rem; font-size: 2rem; }
    p { margin-top: 0; color: #555; }
    ul { list-style: none; padding: 0; margin: 1.5rem 0 0; }
    li { margin: 0.35rem 0; }
    a { color: #1f2937; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { margin-top: 1rem; color: #6b7280; font-size: 0.95rem; }
  </style>
</head>
<body>
  <h1>AFEON Books Source</h1>
  <p>Browse the exported repository contents below. Click a file to view it.</p>
  <div class="meta">Files exported from the repository root.</div>
  <ul>
        ${rows}
  </ul>
</body>
</html>`;

  await fs.writeFile(path.join(rootTarget, "index.html"), html, "utf8");
}

async function main() {
  await fs.rm(target, { recursive: true, force: true });
  await copyDirectory(repoRoot, target);
  await buildIndexHtml(target);
  console.log(`Exported source to ${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
