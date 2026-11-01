import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "artifacts", "site", "dist", "public");
const outputFile = path.join(publicDir, "directory-manifest.json");
async function collectFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath, relativePath));
    else files.push(relativePath);
  }
  return files;
}

const files = (await collectFiles(publicDir)).filter((file) => file !== "directory-manifest.json").sort();
await writeFile(outputFile, `${JSON.stringify(files, null, 2)}\n`);
console.log(`Generated directory manifest with ${files.length} files`);
