// End to end through real Flue (runtime, durable store, hooks) with a scripted model.
// The script builds an Anthropic-shaped request body and passes it through onPayload, the way
// pi-ai's real providers do, so capture, merge and replay run exactly as they would live.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { defineTool, GeneralSubagent, init, observe, useAgentFinish, useModel, useSubagent, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { checkHeads, createFlueHydra, HYDRA_METADATA_KEY, supportsApi, type FlueHydra, type HydraRecord } from "../src/index.ts";

type Sent = { messages: { role: string; content: { type: string; text: string }[] }[]; options?: { sessionId?: string; transport?: string } };
const text = (sent: Sent) => JSON.stringify(sent.messages);
const isHeadRequest = (sent: Sent) => text(sent).includes("You are reviewing the main assistant's work");

const headDirs: string[] = [];
afterAll(() => { for (const dir of headDirs) rmSync(dir, { recursive: true, force: true }); });

function headFile(name: string, extra = "tools: []"): string {
	const dir = mkdtempSync(join(tmpdir(), "hydra-flue-test-"));
	headDirs.push(dir);
	const path = join(dir, `${name}.md`);
	writeFileSync(path, `---\nname: ${name}\ndescription: test head\n${extra}\n---\nCheck the answer.\n`);
	return path;
}

// A scripted model: `driver` answers the agent's requests, `head` answers head requests.
function scripted(api: string, driver: (sent: Sent, index: number) => ReturnType<typeof fauxAssistantMessage>, head: (sent: Sent, index: number) => string) {
	const faux = fauxProvider({ provider: "test", api, models: [{ id: "m", contextWindow: 4000, maxTokens: 100 }] });
	const sent: Sent[] = [];
	let drivers = 0, heads = 0;
	faux.setResponses([async function step(context: any, options: any, _state: unknown, model: any) {
		faux.appendResponses([step]);
		const messages = context.messages.map((m: any) => ({ role: m.role === "toolResult" ? "user" : m.role, content: [{ type: "text", text: JSON.stringify(m.content) }] }));
		// Codex names the conversation `input`; normalized back to `messages` for the assertions.
		const params: any = api === "openai-codex-responses"
			? { model: model.id, input: messages, prompt_cache_key: options?.sessionId }
			: { model: model.id, system: [{ type: "text", text: String(context.systemPrompt ?? "") }], messages };
		const raw: any = (await options?.onPayload?.(params, model)) ?? params;
		const body: Sent = { messages: raw.messages ?? raw.input, options: { sessionId: options?.sessionId, transport: options?.transport } };
		sent.push(body);
		return isHeadRequest(body) ? fauxAssistantMessage(head(body, heads++)) : driver(body, drivers++);
	}]);
	return { provider: faux.provider, sent };
}

const findings = (...items: { action: string; message: string }[]) => JSON.stringify({ findings: items.map((item) => ({ reason: "test", ...item })) });

let hydra: FlueHydra | undefined;
let runtime: { stop(): Promise<void> } | undefined;
afterEach(async () => {
	await runtime?.stop();
	await hydra?.close();
	runtime = hydra = undefined;
});

async function run(options: { api?: string; heads?: string[]; maxRounds?: number; agent?: (hydra: FlueHydra, heads: string[], onRecord: (record: HydraRecord) => void) => () => string; driver: Parameters<typeof scripted>[1]; head: Parameters<typeof scripted>[2]; messages?: string[]; tolerateFailures?: boolean }) {
	const records: HydraRecord[] = [];
	const logs: { level: string; message: string }[] = [];
	const unobserve = observe((event) => { if (event.type === "log") logs.push({ level: event.level, message: event.message }); });
	const model = scripted(options.api ?? "anthropic-messages", options.driver, options.head);
	hydra = createFlueHydra({ maxRounds: options.maxRounds });
	const h = hydra;
	const heads = options.heads ?? [headFile("checker")];
	const onRecord = (record: HydraRecord) => records.push(record);
	const Agent = options.agent?.(h, heads, onRecord) ?? function Agent() { useModel("test/m"); h.useHydra(heads, { onRecord }); return "You answer questions."; };
	runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [h.wrap(model.provider)] });
	const handle = init(Agent);
	const replies: any[] = [];
	for (const message of options.messages ?? ["What is 17 times 23?"]) {
		const reply = handle.read(await handle.dispatch(message));
		replies.push(options.tolerateFailures ? await reply.catch((error: unknown) => error) : await reply);
	}
	unobserve();
	const hydraMetadata = replies.map((reply) => reply?.metadata?.[HYDRA_METADATA_KEY]);
	return { replies, records, hydraMetadata, logs, sent: model.sent };
}

describe("pi-hydra heads in Flue", () => {
	it("a steer is appended, the agent corrects, and the next check settles the response", async () => {
		const result = await run({
			driver: (_sent, i) => fauxAssistantMessage(i === 0 ? "17 × 23 = 401" : "Corrected: 391"),
			head: (_sent, i) => (i === 0 ? findings({ action: "steer", message: "17 × 23 is 391 <not 401> & check \"tools\"" }) : findings()),
		});
		// Flue's reply text holds the whole response, the wrong first answer included; the metadata has the final step.
		expect(result.replies[0].text).toBe("17 × 23 = 401\n\nCorrected: 391");
		expect(result.hydraMetadata).toEqual([{ reviewed: true, final: "Corrected: 391" }]);
		expect(result.records.map((r) => [r.round, r.outcome])).toEqual([[0, "findings"], [1, "none"]]);
		const [driver1, head1, driver2] = result.sent;
		// The head replays the driver's request unchanged, then the final answer, then its prompt.
		expect(head1.messages.slice(0, driver1.messages.length)).toEqual(driver1.messages);
		expect(JSON.stringify(head1.messages[driver1.messages.length])).toContain("401");
		// The finding reaches the agent's next request exactly once.
		expect(text(driver2).split("[pi-hydra checker]").length - 1).toBe(1);
		expect(text(driver2)).toContain("391");
	});

	it("a print finding is logged for people and never reaches the agent", async () => {
		const result = await run({
			driver: () => fauxAssistantMessage("391"),
			head: () => findings({ action: "print", message: "looks fine, by the way" }),
		});
		expect(result.records).toHaveLength(1);
		expect(result.logs).toContainEqual({ level: "info", message: "[pi-hydra checker] looks fine, by the way" });
		expect(result.sent.filter((s) => !isHeadRequest(s))).toHaveLength(1);
	});

	it("a failed check is logged as a warning and recorded; the response settles", async () => {
		const result = await run({ driver: () => fauxAssistantMessage("391"), head: () => "not json" });
		expect(result.replies[0].text).toBe("391");
		expect(result.records[0]).toMatchObject({ outcome: "failed", errorKind: "malformed-findings" });
		expect(result.logs.some((log) => log.level === "warn" && log.message.startsWith("[pi-hydra checker] check failed"))).toBe(true);
	});

	it("after maxRounds of feedback the findings are logged as unresolved and the response settles", async () => {
		const result = await run({
			maxRounds: 2,
			driver: (_sent, i) => fauxAssistantMessage(`attempt ${i}`),
			head: () => findings({ action: "steer", message: "still wrong" }),
		});
		expect(result.replies[0].text).toMatch(/attempt 2$/);
		expect(result.records.map((r) => [r.round, r.unresolved])).toEqual([[0, false], [1, false], [2, true]]);
		expect(result.logs.some((log) => log.level === "warn" && log.message.includes("unresolved after 2 rounds"))).toBe(true);
	});

	it("a response that fails after a correction does not use up the next response's rounds", async () => {
		const result = await run({
			maxRounds: 1,
			// First response: a wrong answer, a steer, then the correction attempt fails.
			// Second response: a wrong answer, a steer, the correction.
			driver: (_sent, i) => i === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request" })
				: fauxAssistantMessage(i === 3 ? "391" : "401"),
			// The answer under review is the message just before the head's prompt.
			head: (sent) => findings(...(JSON.stringify(sent.messages.at(-2)).includes("401") ? [{ action: "steer", message: "17 × 23 is 391" }] : [])),
			messages: ["first question", "second question"],
			tolerateFailures: true,
		});
		expect(result.replies[0]).toBeInstanceOf(Error);
		expect(result.replies[1].text).toMatch(/391$/);
		expect(result.records.map((r) => [r.round, r.outcome])).toEqual([[0, "findings"], [0, "findings"], [1, "none"]]);
	});

	it.each(["anthropic-messages", "openai-codex-responses"])("after a terminating tool the head sees the call and its real result (%s)", async (api) => {
		const result = await run({
			api,
			agent: (h, heads, onRecord) => function Agent() {
				useModel("test/m");
				useTool(defineTool({ name: "submit", description: "Submit.", input: v.object({ answer: v.number() }), run: ({ data }) => ({ output: `stored ${data.answer}`, terminate: true }) }));
				h.useHydra(heads, { onRecord });
				return "Submit the answer.";
			},
			driver: () => fauxAssistantMessage(fauxToolCall("submit", { answer: 401 }), { stopReason: "toolUse" }),
			head: () => findings(),
		});
		const head = result.sent.find(isHeadRequest)!;
		expect(text(head)).toContain("stored 401");
		expect(text(head)).toMatch(/answer.{0,8}401/); // the call's arguments, not only its result
		expect(text(head)).not.toContain("No result provided");
	});

	it("subagent calls are not reviewed as the conversation; the head replays the agent's own last request", async () => {
		const result = await run({
			agent: (h, heads, onRecord) => function Agent() { useModel("test/m"); useSubagent(GeneralSubagent); h.useHydra(heads, { onRecord }); return "Delegate, then answer."; },
			driver: (sent) => text(sent).includes("sub task please")
				? fauxAssistantMessage("sub result")
				: text(sent).includes("sub result")
					? fauxAssistantMessage("final answer")
					: fauxAssistantMessage(fauxToolCall("task", { agent: "flue-general", prompt: "sub task please" }), { stopReason: "toolUse" }),
			head: () => findings(),
		});
		const lastDriver = result.sent.filter((s) => !isHeadRequest(s)).at(-1)!;
		const head = result.sent.find(isHeadRequest)!;
		expect(text(lastDriver)).toContain("sub result");
		expect(head.messages.slice(0, lastDriver.messages.length)).toEqual(lastDriver.messages);
	});

	it("a compaction after the agent's last request is not reviewed as the conversation", async () => {
		// Flue compacts right after a run's final turn once the threshold is crossed, before the
		// finish hook: the summarization request is then the last provider call the head could see.
		const result = await run({
			agent: (h, heads, onRecord) => function Agent() { useModel("test/m", { compaction: { reserveTokens: 1000, keepRecentTokens: 20 } }); h.useHydra(heads, { onRecord }); return "Answer briefly."; },
			driver: (sent) => {
				const summarizing = text(sent).includes("context summarization assistant");
				const message = fauxAssistantMessage(summarizing ? "## Summary\nearlier work" : "noted " + "x".repeat(20));
				message.usage = { ...message.usage, input: summarizing ? 10 : 3900, totalTokens: summarizing ? 10 : 3900 };
				return message;
			},
			head: () => findings(),
			messages: Array.from({ length: 6 }, (_, i) => `message ${i} ${"w".repeat(2000)}`),
		});
		const isSummary = (s: Sent) => text(s).includes("context summarization assistant");
		let headsRightAfterSummary = 0;
		result.sent.forEach((sent, index) => {
			if (!isHeadRequest(sent)) return;
			const before = result.sent.slice(0, index);
			if (isSummary(before.at(-1)!)) headsRightAfterSummary++;
			const lastAgent = before.filter((s) => !isHeadRequest(s) && !isSummary(s)).at(-1)!;
			expect(sent.messages.slice(0, lastAgent.messages.length)).toEqual(lastAgent.messages);
		});
		expect(headsRightAfterSummary).toBeGreaterThan(0);
	});

	it("Codex heads share the driver's session over a full-input transport", async () => {
		const result = await run({ api: "openai-codex-responses", driver: () => fauxAssistantMessage("391"), head: () => findings() });
		const [driver, head] = result.sent;
		expect(isHeadRequest(head)).toBe(true);
		expect(driver.options?.transport).toBe("websocket");
		expect(driver.options?.sessionId).toBeTruthy();
		expect(head.options).toEqual(driver.options);
		expect(result.records[0]).toMatchObject({ outcome: "none" });
	});

	it("an agent without heads is left alone: nothing recorded, its Codex transport unchanged", async () => {
		const records: HydraRecord[] = [];
		const model = scripted("openai-codex-responses", () => fauxAssistantMessage("391"), () => findings());
		hydra = createFlueHydra();
		const h = hydra;
		const heads = [headFile("checker")];
		function Reviewed() { useModel("test/m"); h.useHydra(heads, { onRecord: (r) => records.push(r) }); return "x"; }
		function Plain() { useModel("test/m"); return "x"; }
		runtime = await start({ agents: [{ agent: Reviewed, name: "reviewed" }, { agent: Plain, name: "plain" }], providers: [h.wrap(model.provider)] });
		for (const Agent of [Plain, Reviewed]) {
			const handle = init(Agent);
			await handle.read(await handle.dispatch("go"));
		}
		const [plain, reviewed] = model.sent.filter((s) => !isHeadRequest(s));
		expect(plain.options?.transport).toBe("auto"); // Flue's default, untouched
		expect(reviewed.options?.transport).toBe("websocket");
		expect(records.map((r) => r.outcome)).toEqual(["none"]);
	});

	it("the response metadata has the final answer after every finish hook, also when another hook keeps it going", async () => {
		let appended = false;
		const result = await run({
			agent: (h, heads, onRecord) => function Agent() {
				useModel("test/m");
				h.useHydra(heads, { onRecord });
				useAgentFinish((ctx) => { if (!appended) { appended = true; ctx.append({ kind: "signal", type: "another-check", body: "Please correct once more." }); } });
				return "Answer.";
			},
			driver: (_sent, i) => fauxAssistantMessage(i === 0 ? "old answer" : "new answer"),
			head: () => findings(),
		});
		expect(result.replies[0].text).toBe("old answer\n\nnew answer");
		expect(result.hydraMetadata).toEqual([{ reviewed: true, final: "new answer" }]);
	});

	it("close() tries to release every session even when one cleanup fails", async () => {
		const model = scripted("openai-codex-responses", () => fauxAssistantMessage("answer"), () => findings());
		const h = createFlueHydra();
		hydra = h;
		const heads = [headFile("checker")];
		function Agent() { useModel("test/m"); h.useHydra(heads); return "Answer."; }
		runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [h.wrap(model.provider)] });
		for (let i = 0; i < 2; i++) {
			const handle = init(Agent);
			await handle.read(await handle.dispatch("go"));
		}
		const ids = [...new Set(model.sent.map((s) => s.options?.sessionId))];
		expect(ids).toHaveLength(2);
		await runtime.stop();
		runtime = undefined;
		const cleaned: string[] = [];
		const unregister = registerSessionResourceCleanup((id) => { cleaned.push(id!); if (id === ids[0]) throw new Error("injected cleanup failure"); });
		try { await expect(h.close()).rejects.toThrow(AggregateError); } finally { unregister(); hydra = undefined; }
		expect(cleaned).toEqual(ids);
	});

	it("a second close() retries only the sessions whose cleanup failed", async () => {
		const model = scripted("openai-codex-responses", () => fauxAssistantMessage("answer"), () => findings());
		const h = createFlueHydra();
		hydra = h;
		const heads = [headFile("checker")];
		function Agent() { useModel("test/m"); h.useHydra(heads); return "Answer."; }
		runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [h.wrap(model.provider)] });
		for (let i = 0; i < 2; i++) {
			const handle = init(Agent);
			await handle.read(await handle.dispatch("go"));
		}
		const ids = [...new Set(model.sent.map((s) => s.options?.sessionId))];
		await runtime.stop();
		runtime = undefined;
		const calls: string[] = [];
		const open = new Set(ids);
		let first = true;
		const unregister = registerSessionResourceCleanup((id) => {
			calls.push(id!);
			if (id === ids[0] && first) { first = false; throw new Error("transient cleanup failure"); }
			open.delete(id);
		});
		try {
			await expect(h.close()).rejects.toThrow(AggregateError);
			calls.length = 0;
			await h.close();
			expect(calls).toEqual([ids[0]]);
			expect([...open]).toEqual([]);
		} finally { unregister(); hydra = undefined; }
	});

	it("an unsupported provider API is reported, not silently skipped", async () => {
		const result = await run({ api: "test-api", driver: () => fauxAssistantMessage("391"), head: () => findings() });
		expect(result.records[0]).toMatchObject({ outcome: "failed", errorKind: "unsupported-api" });
		expect(result.sent.some(isHeadRequest)).toBe(false);
		expect(result.hydraMetadata).toEqual([{ reviewed: false, final: "391" }]);
	});

	it("an agent whose provider is not wrapped reports that heads could not run", async () => {
		const records: HydraRecord[] = [];
		const model = scripted("anthropic-messages", () => fauxAssistantMessage("391"), () => findings());
		hydra = createFlueHydra();
		const h = hydra;
		const heads = [headFile("checker")];
		function Agent() { useModel("test/m"); h.useHydra(heads, { onRecord: (record) => records.push(record) }); return "x"; }
		runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [model.provider] });
		const handle = init(Agent);
		await handle.read(await handle.dispatch("hi"));
		expect(records[0]).toMatchObject({ outcome: "failed", errorKind: "no-capture" });
	});

	it("heads that use tools, are invalid or missing are refused", () => {
		expect(() => checkHeads([headFile("actor", "tools: read")])).toThrow(/judge heads only/);
		expect(() => checkHeads([headFile("open", "description2: x")])).toThrow(/invalid head file/);
		expect(() => checkHeads([join(tmpdir(), "no-such-head.md")])).toThrow(/ENOENT/);
		expect(() => checkHeads([])).toThrow(/no heads/);
		expect(checkHeads([headFile("checker")])).toEqual(["checker"]);
	});

	it("supportsApi names the provider APIs heads can review", () => {
		expect([supportsApi("anthropic-messages"), supportsApi("openai-codex-responses"), supportsApi("openai-responses")]).toEqual([true, true, false]);
	});

	it("each agent is reviewed by its own heads", async () => {
		const records: HydraRecord[] = [];
		const model = scripted("anthropic-messages", () => fauxAssistantMessage("391"), () => findings());
		hydra = createFlueHydra();
		const h = hydra;
		const [math, style] = [[headFile("math")], [headFile("style"), headFile("tone")]];
		const seen: string[] = [];
		function Math() { useModel("test/m"); h.useHydra(math, { onRecord: (r) => { records.push(r); seen.push(`math:${r.head}`); } }); return "Multiply."; }
		function Writer() { useModel("test/m"); h.useHydra(style, { onRecord: (r) => { records.push(r); seen.push(`writer:${r.head}`); } }); return "Write."; }
		runtime = await start({ agents: [{ agent: Math, name: "math" }, { agent: Writer, name: "writer" }], providers: [h.wrap(model.provider)] });
		for (const Agent of [Math, Writer]) {
			const handle = init(Agent);
			await handle.read(await handle.dispatch("go"));
		}
		expect(seen).toEqual(["math:math", "writer:style", "writer:tone"]);
	});
});
