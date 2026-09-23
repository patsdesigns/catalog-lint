import { readFileSync } from "node:fs";
import { join } from "node:path";

// The app version, read once from package.json at the project root (where the app runs from, in
// development and in the Docker image). It is the single place the version is written; releases
// bump it with `npm version` (see the README).
function readVersion() {
  try {
    // eslint-disable-next-line no-undef
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
