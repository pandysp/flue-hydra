// Installs flue-hydra the way a Flue app does and checks that it works there.
//   npm run consumer
// Packs this repository (which builds dist/), installs the tarball with --ignore-scripts into a fresh app next to the
// Flue and pi-ai versions the README documents, and checks that:
//   - pi-hydra and pi's own packages are not installed into the app;
//   - the published types contain no pi-hydra import and are concrete (a wrong value is a type error, not `any`);
//   - a scripted agent with a wrong answer is steered by a head and corrects itself.
// Needs the npm registry; makes no model calls.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLUE = "2.2.2";
const PI_AI = "0.87.1"; // the version Flue 2.2.2 depends on
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = mkdtempSync(join(tmpdir(), "flue-hydra-consumer-"));
const run = (command, args, cwd = app) => execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const fail = (message) => { throw new Error(`consumer check: ${message}`); };
try {
	run("npm", ["pack", "--silent", "--pack-destination", app], repo);
	const tarball = readdirSync(app).find((name) => name.endsWith(".tgz"));
	writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
	run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--ignore-scripts", `./${tarball}`, `@flue/runtime@${FLUE}`, `@earendil-works/pi-ai@${PI_AI}`, "typescript@5", "@types/node@22"]);

	const installed = run("npm", ["ls", "--all", "--parseable"]);
	if (/node_modules\/pi-hydra\b|pi-coding-agent|pi-tui/.test(installed)) fail("installing flue-hydra pulled pi-hydra or pi's own packages into the app");
	const types = readFileSync(join(app, "node_modules/@pandysp/flue-hydra/dist/index.d.ts"), "utf8");
	if (/from ["']pi-hydra/.test(types)) fail("dist/index.d.ts still imports pi-hydra");

	writeFileSync(join(app, "head.md"), "---\nname: checker\ndescription: checks the product\ntools: []\n---\nCheck the product.\n");
	writeFileSync(join(app, "types.ts"), `import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra, type HydraRecord } from "@pandysp/flue-hydra";
const records: HydraRecord[] = [];
const hydra = createFlueHydra({ maxRounds: 2 });
function Agent() { useModel("anthropic/claude-opus-5-5"); hydra.useHydra(["head.md"], { onRecord: (record) => records.push(record) }); return "x"; }
export const boot = () => start({ agents: [Agent], providers: [hydra.wrap(anthropicProvider())] });
// Each line below must be a type error. If a type had silently become \`any\`, the directive itself would fail.
// @ts-expect-error a finding is a Decision, not a string
export const finding: HydraRecord["findings"][number] = "not a decision";
// @ts-expect-error usage is ObservationUsage, not a string
export const usage: NonNullable<HydraRecord["usage"]> = "not usage";
// @ts-expect-error errorKind is a closed set of strings
export const kind: HydraRecord["errorKind"] = "made-up-kind";
`);
	// skipLibCheck: Flue 2.2.2's own declaration files don't compile on their own (TS2846, missing optional MCP types).
	writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] }, files: ["types.ts"] }));
	run("npx", ["tsc", "-p", "tsconfig.json"]);

	writeFileSync(join(app, "app.mjs"), `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { init, useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra } from "@pandysp/flue-hydra";
const faux = fauxProvider({ provider: "test", api: "anthropic-messages", models: [{ id: "m" }] });
let drivers = 0, heads = 0;
faux.setResponses([async function step(context, options, _state, model) {
	faux.appendResponses([step]);
	const params = { model: model.id, messages: context.messages.map((m) => ({ role: m.role === "toolResult" ? "user" : m.role, content: [{ type: "text", text: JSON.stringify(m.content) }] })) };
	const sent = (await options?.onPayload?.(params, model)) ?? params;
	if (JSON.stringify(sent).includes("reviewing the main assistant")) return fauxAssistantMessage(heads++ === 0 ? JSON.stringify({ findings: [{ action: "steer", reason: "r", message: "17 x 23 is 391" }] }) : '{"findings":[]}');
	return fauxAssistantMessage(drivers++ === 0 ? "401" : "391");
}]);
const hydra = createFlueHydra();
function Agent() { useModel("test/m"); hydra.useHydra(["head.md"]); return "Multiply."; }
const flue = await start({ agents: [Agent], providers: [hydra.wrap(faux.provider)] });
const handle = init(Agent);
const reply = await handle.read(await handle.dispatch("17 times 23?"));
await flue.stop();
await hydra.close();
if (!reply.text.endsWith("391") || heads !== 2) throw new Error("expected a steer and a corrected reply, got " + JSON.stringify(reply.text));
`);
	run("node", ["app.mjs"]);
	console.log(`consumer check passed: @pandysp/flue-hydra installs with --ignore-scripts, has concrete types and corrects an agent (Flue ${FLUE}, pi-ai ${PI_AI})`);
} finally {
	rmSync(app, { recursive: true, force: true });
}
