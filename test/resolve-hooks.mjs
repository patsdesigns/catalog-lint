// Resolve hook for test/register.mjs: a relative import that Node cannot find is retried with the
// extensions the app uses.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (err.code === "ERR_MODULE_NOT_FOUND" && relative && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".js", ".mjs", ".jsx", "/index.js"]) {
        if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
      }
    }
    throw err;
  }
}
