import { promises as fs, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

// Serialize saves that target the same file so two writers never interleave
// their tmp-file renames. The chain absorbs a failed write so later writes
// still run; the caller gets the rejection so a lost save is observable
// instead of silently swallowed.
export function serializeWrites(): (task: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export function writeJsonAtomicSync(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sync.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}
