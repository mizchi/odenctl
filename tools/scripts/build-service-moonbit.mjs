import { build } from "../../sdk/moonbit/build.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
build(process.argv[2] ?? resolve(root, "examples/service-moonbit"), { wit: resolve(root, "wit/app") });
