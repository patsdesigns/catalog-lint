// `node --import ./test/register.mjs <script>`: lets plain Node import the app's extensionless
// relative modules ("./rules.server"), which Vite resolves but the Node ESM loader does not.
import { register } from "node:module";

register(new URL("./resolve-hooks.mjs", import.meta.url));
