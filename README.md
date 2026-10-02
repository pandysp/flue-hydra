# flue-hydra

[Flue](https://flueframework.com/) agents can be reviewed by the same heads as pi. When an agent
is about to finish a response, each head checks it. A finding the agent must act on is added to
the response, so the agent corrects itself before anyone reads its answer.

A check costs little because of how it is built. The head does not read the conversation
afresh: Hydra replays the agent's last request to the provider unchanged, which the provider
serves from its cache, and adds only the agent's last turn and the head's instructions.

flue-hydra brings [pi-hydra](https://github.com/pandysp/pi-hydra)'s heads to Flue. Heads are pi-hydra's
Markdown head files; its [head guide](https://github.com/pandysp/pi-hydra/blob/main/docs/heads.md) explains
how to write one. Its bundled `quality`, `security`, `simplifier`, `api-design` and `navigator` heads are judges
(`tools: []`), so flue-hydra accepts them; only an arithmetic test head has run in Flue so far.

## Setup

Needs `@flue/runtime` 2.2.2 or later 2.x, next to the pi-ai version that Flue release depends on (0.87.x for
Flue 2.2.2):

```bash
npm install @pandysp/flue-hydra @flue/runtime@2.2.2 @earendil-works/pi-ai@0.87.1
```

A pi-ai version different from Flue's gives the wrapped provider incompatible types.

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra } from "@pandysp/flue-hydra";

const hydra = createFlueHydra();

function Reviewer() {
	useModel("anthropic/claude-opus-5-5");
	hydra.useHydra(["/path/to/heads/quality.md"]); // review each response before it settles
	return "You review pull requests.";
}

const flue = await start({ agents: [Reviewer], providers: [hydra.wrap(anthropicProvider())] });
// ... run the agent ...
await flue.stop();
await hydra.close(); // also closes the Codex connections Hydra kept open
```

Three pieces work together:

- `hydra.wrap(provider)` records each request the agent sends. Use the wrapped provider in
  `start({ providers })` or `setProvider()`.
- `hydra.useHydra(heads)` inside the agent function names the head files that review this agent and runs
  them when a response is about to settle. Different agents can use different heads.
- `createFlueHydra()` installs one Flue instrumentation, which tells Hydra which conversation
  each request belongs to. `close()` removes it.

Options of `createFlueHydra()`: `maxRounds` (default 3, below) and `onRecord`, called once per head check
with the conversation, head, round, outcome, findings, any error, the token usage and whether its findings
stayed `unresolved`.

Two helpers let a host check its setup before running anything: `checkHeads(paths)` reads and validates
head files the way `useHydra()` does (it throws on a missing, invalid or tool-using head), and
`supportsApi(model.api)` says whether heads can review a model's provider API.

## What a check sees

The head receives:

1. the agent's last request to the provider, byte for byte;
2. the agent's last turn after it: its answer and the real results of any tools it called, also
   when a tool ended the run;
3. the head's instructions and the answering rules.

Only requests of the agent's own conversation are recorded. Subagent tasks and scratch prompts
run in conversations of their own, and Flue's compaction requests are excluded by their purpose.

Heads must be judges: `tools: []` in the head file. Heads that use tools are refused when Hydra
is created.

## What happens to findings

| Finding | In Flue |
|---|---|
| `steer` | Added to the response as one `pi-hydra` signal; the agent reads it and keeps working |
| `interrupt` | The same as `steer`: Flue cannot stop a turn in progress without discarding it |
| `print` | Written to the conversation log for the people watching; the agent never sees it |
| none | The response settles |

Heads are told this, instead of pi's behaviour. After the agent's next turn the heads check
again. After `maxRounds` rounds of feedback in one response, further findings are logged as
warnings marked unresolved and the response settles, rather than running Flue into its own limit
of 32 continuations, which fails the response. Rounds, and what heads have already sent, are
counted per response: the next response starts fresh.

A check that fails (provider error, malformed answer, unsupported provider) is logged as a
warning and recorded; the response settles unchanged.

## Providers

Supported: Anthropic Messages and OpenAI Codex. Other provider APIs are reported as failed checks.

For Codex, Hydra runs the agent on pi-ai's `websocket` transport instead of its default `auto`,
and the heads share the agent's provider session. Codex caches by session, and sharing is safe
only while the agent sends its full input every turn, which `auto` does not. This is the one
change Hydra makes to the agent itself. A caller that sets a continuing transport explicitly gets
an error instead. See [Session sharing](https://github.com/pandysp/pi-hydra/blob/main/docs/providers.md#session-sharing) in pi-hydra and
the [measurements](#measurements) below.

## Limits

- **Run end only.** Heads check when a response is about to settle, not while it runs. A long
  response is not interrupted mid-way.
- **Advisory, like pi-hydra.** If the process stops while heads are checking, Flue 2.2.2 settles
  the response as successful after restart without running the check again
  ([withastro/flue#810](https://github.com/withastro/flue/issues/810)).
- **Added time.** The response waits for the slowest head before it settles: 1.1–10.1 s per round
  in the measured runs (October 1–2, 2026), with one Anthropic check at 58.7 s.
- **After compaction** the agent's request starts with a fresh summary, so the first check reads
  less from cache.
- **Claude subscription logins.** Whether a request counts against the plan or is refused as
  third-party use depends on what it contains. Flue requests have been accepted on the plan in
  every test so far; pi's own requests without an extra billing extension were refused.

## Measurements

Measured October 1–2, 2026 with [`scripts/live-check.mjs`](scripts/live-check.mjs) (Flue 2.2.2, pi-ai
0.87.1, low thinking, subscription logins, one judge head, a prefix of about 4K–7K tokens). Each check is a
run-end check: the agent's last request, its last turn and the head prompt.

| Provider | First check of a response | Check after a correction |
|---|---|---|
| Anthropic, Opus 5.5 | 5,974–6,053 of about 6,760–7,000 input tokens read from cache in 7/7 runs; the rest is the final turn written to cache plus 4 new tokens; $0.006–$0.011 per check where recorded, 2.5–7.1 s | 6,209 and 6,382 of about 7,200–7,280 read (2 runs) |
| Codex, GPT-5.5, heads on the agent's session | 3,584 of 3,922–3,964 read in 10/14 runs, 2,560 in 4/14, never 0; 2.0–5.6 s | 2,560 of about 4,030–4,075 read in 14/14 runs |
| Codex, heads on their own session | 3,584 read in 4/7 runs, 0 in 3/7 | 2,560 read in 7/7 runs |

On October 2, on the final code (heads in `useHydra(heads)`), 4 Anthropic runs read 6,091–6,132 of
6,800–6,924 on the first check and 6,234–6,294 of 7,251–7,317 after a correction (3 runs), at 3.4–10.1 s
per check with one at 58.7 s; 3 Codex runs read 2,560 of 3,991–4,021 and then 2,560 of 4,084–4,114, at
1.8–4.6 s.

The Codex rows are why the agent runs on the `websocket` transport and shares its session with the heads. An
earlier spike with a 13–22K prefix and a tool call over two turns measured the same pattern at larger size:
Anthropic replays read 22,513–22,603 tokens with 4 new, Codex 12,800.

## Checking it yourself

[`scripts/live-check.mjs`](scripts/live-check.mjs) runs an agent whose multiply tool is wrong, with a head
that checks arithmetic, on an existing pi login (`~/.pi/agent/auth.json`):

```bash
npm ci
node scripts/live-check.mjs anthropic   # or codex
```

It asks for 1847 × 2963 and prints the reply, each check and its cache numbers. Passing means
`"correct": true` with one `pi-hydra` signal, unless the model noticed the wrong tool result on its own.

## Development

```bash
npm ci              # also builds dist/
npm run check       # types
npm test            # the adapter's tests, through real Flue with a scripted model
npm run consumer    # pack, install into a fresh Flue app with --ignore-scripts, check types and a correction
```

pi-hydra's core (`utils.ts`, `judge.ts`, `delivery.ts`) comes from pi-hydra at the commit pinned in
`package.json`. The build bundles it into `dist/index.js` (esbuild) and its types into `dist/index.d.ts`
(rollup-plugin-dts), so apps install neither pi-hydra nor pi. To pick up pi-hydra changes, move the pin to a
newer commit and run the checks; npm 12 needs `allow-git=root` (in `.npmrc`) for that git dependency.

Releases: bump `version`, push a `v<version>` tag; GitHub Actions publishes to npm with provenance through
trusted publishing.
