import { pathToFileURL, fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { register } from "node:module";

/**
 * Node ESM resolve hook that maps ".js" import specifiers to ".ts" files
 * when the .ts source exists. Required because this project uses TypeScript
 * without a build step and imports use .js extensions per ESM convention.
 */

export async function resolve(specifier, context, nextResolve) {
  const parentUrl = context.parentURL;

  // Only rewrite .js specifiers that originate from a project .ts file.
  if (specifier.endsWith(".js") && parentUrl) {
    const parentPath = fileURLToPath(parentUrl);
    const base = specifier.slice(0, -3);
    const candidate = new URL(base + ".ts", parentUrl);
    const candidatePath = fileURLToPath(candidate);
    try {
      statSync(candidatePath);
      return { url: candidate.href, shortCircuit: true };
    } catch {
      // Fall through to default resolution.
    }
  }

  return nextResolve(specifier, context);
}

register(import.meta.url, import.meta.url);
