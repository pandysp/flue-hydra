// Types only: merges the types of pi-hydra's core into dist/index.d.ts, so apps don't need pi-hydra.
// The JavaScript is bundled by esbuild (see the build script).
import { dts } from "rollup-plugin-dts";

export default {
	input: "src/index.ts",
	output: { file: "dist/index.d.ts" },
	external: [/^@flue\//, /^@earendil-works\//, /^node:/],
	plugins: [dts({ respectExternal: true, compilerOptions: { allowImportingTsExtensions: true } })],
};
