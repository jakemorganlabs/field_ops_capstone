import { createHash } from "node:crypto";
import { mkdir, rename, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve } from "node:path";

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

function safePath(rootDir: string, key: string): string {
  const resolvedRoot = resolve(rootDir);
  const target = resolve(join(resolvedRoot, key));
  const relative = relativePath(resolvedRoot, target);
  if (relative.startsWith("..") || relative.startsWith("/")) {
    throw new Error("object key escapes root directory");
  }
  return target;
}

export function fsObjectStore(rootDir: string): ObjectStore {
  return {
    async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
      const targetPath = safePath(rootDir, key);
      await mkdir(dirname(targetPath), { recursive: true });
      const tmpName = `${targetPath}.${createHash("sha256").update(key).update(String(Date.now())).digest("hex")}.tmp`;
      await writeFile(tmpName, bytes);
      await rename(tmpName, targetPath);
    },

    async get(key: string): Promise<Buffer> {
      const targetPath = safePath(rootDir, key);
      return readFile(targetPath);
    },

    async exists(key: string): Promise<boolean> {
      const targetPath = safePath(rootDir, key);
      try {
        await stat(targetPath);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return false;
        }
        throw err;
      }
    },
  };
}
