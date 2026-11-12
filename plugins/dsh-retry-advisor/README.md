# AI retry advisor

`@pcmid/dsh-retry-advisor` decides what to do with a failed model request after every built-in recovery handler has declined. It asks a model why the request failed and whether resending it can succeed, and shows the decision in the conversation. If the analysis itself fails, the failure stays terminal and the turn ends as it did before.

## Behavior

The plugin listens on `agent/request-error` and first calls `next()`, so these handlers always go first:

- `dsh-llm-retry` retries the route's transient codes (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` by default).
- Context compaction handles `CONTEXT_WINDOW_EXCEEDED`; image offload handles `IMAGE_OFFLOAD_REQUIRED`.

Only when they all leave the failure terminal does the advisor act:

1. Codes in `skipCodes` (default `ABORTED`) stay terminal.
2. When this plugin has already granted `maxRetriesPerStep` retries in the same step, the failure stays terminal.
3. With **Drop invalid thinking** on, a rejection of the history's thinking as invalid gets a fixed repair without analysis; see [Drop invalid thinking](#drop-invalid-thinking).
4. Otherwise one analysis request goes to the configured model, or to the conversation's current model when none is configured. It runs without thinking unless `reasoningEffort` is set, and with the model's default output cap unless `maxTokens` is set. It receives the failure code, HTTP status, retry-after hint, the failure message (head and tail, up to `maxFailureChars`), and the earlier failures and decisions in this step. It does not receive the conversation.
5. The answer is one JSON line: `retry`, `delayMs`, `cause`, and `reason`. On `retry: true` the plugin waits `delayMs` (capped by `maxDelayMs`) and resends the identical request. On `retry: false` the failure stays terminal. With `allowGiveUp: false` the analysis only chooses the delay.
6. A failed, timed-out (`timeoutMs`), or unparsable analysis leaves the failure terminal.

A retry resends the same request; the plugin cannot change the messages, tools, or model. Drop invalid thinking is the one exception, and it changes only how the provider treats that thinking.

The analysis prompt treats a provider safety, usage-policy, or terms-of-service block (for example `This request was blocked as it seems to violate … Terms of Service`) as worth one retry: these classifiers also judge the output being generated, so on ordinary software work they often fire falsely and a resend that samples new output passes. The same block repeated in one step is not retried again.

## Drop invalid thinking

A switch on the plugin's page in Plugins (**丢弃无效思考** / **Drop invalid thinking**, config field `dropInvalidThinking`). It is off by default, because the dropped thinking leaves the model's context.

Some failures come from thinking in the conversation history that the provider no longer accepts. A forked or seeded conversation, for example, replays thinking blocks whose signatures the provider bound to the parent conversation, and an Anthropic Messages endpoint then rejects every request with a 400 such as `Invalid signature in thinking block. The block is bound to a different conversation. Remove the block, or set thinking.block_binding.prefix_mismatch_behavior to "drop_block"`. Resending the same request always fails the same way.

With the switch on, the advisor answers such a failure without asking a model:

1. It switches the conversation to dropping invalid thinking and retries at once.
2. From then on, every request of that conversation carries the drop in the way its API provides, so the provider stops rejecting the thinking. That includes auxiliary requests that share the conversation's session, such as title generation, compaction, and auto-review; only this plugin's own analysis request never carries it.
3. When a conversation request that carried the drop still fails because of it (the provider rejects the drop parameter, or still rejects the thinking), the next attempt goes out once as an ordinary request without the drop. Later requests carry it again.
4. When that ordinary request fails too, the failure goes to the ordinary analysis, which sees both earlier retries.

Each of these retries counts toward `maxRetriesPerStep`.

Each API rejects and drops invalid thinking differently, so the plugin keeps one entry per API in `THINKING_DROPPERS`: how to recognize the rejection, and how to change a request body to drop the thinking. Supported:

| API | Rejection | Drop |
| --- | --- | --- |
| Anthropic Messages | a thinking block bound to a different conversation (`prefix_mismatch_behavior` in the message); a failure mentioning `block_binding` counts as the drop failing | add `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` and the `anthropic-beta` feature `thinking-binding-controls-2026-08-01` (appended to the request's other betas), as pi-ai pairs them; requests with disabled thinking or without a `thinking` object are left unchanged |

The switch is volatile: the running plugin reads it on every failure and every request, so saving it takes effect without a reload. Turning it off stops the dropping at once, also in conversations that were already switched.

`llm-pi-ai` offers no hook for request-body fields, so the plugin marks the switched conversations' requests in the `llm-pi-ai/request-headers` waterfall and wraps the process `fetch` the first time a conversation is switched. The wrapper removes the marker header from every marked request, rewrites its JSON body, and adds the betas the rewrite needs; unmarked requests pass through untouched. Unloading the plugin restores the previous `fetch`.

## Decisions in the conversation

Each failure the advisor handles gets one row in the Chat view, in the failed Turn and outside its process disclosure, so it stays visible when the Turn is folded:

| Row | Meaning |
| --- | --- |
| Analyzing the failure | The analysis request is running. It reads as cancelled when the Turn stops first. |
| Retrying in N seconds (attempt i/max) | The analysis chose to resend; the row shows the cause and reason. |
| Retrying now with invalid thinking dropped (attempt i/max) | Drop invalid thinking switched the conversation; no analysis ran. |
| Still failing with the drop, retrying as an ordinary request (attempt i/max) | A request that carried the drop failed because of it; the next attempt goes without it once; no analysis ran. |
| Not retrying | The analysis judged that a resend fails the same way; the row shows the cause and reason. |
| Analysis failed | The analysis request failed, timed out, or answered unusably; the row shows the error. |
| Retries used up | This step already used `maxRetriesPerStep` retries. |

Details under each row name the original failure code and message and the analysis model and effort. The rows come from `plugin:retry-advisor/decision` records in the Session log: one when the analysis starts and one with the outcome, both carrying the same `id` and the complete state. The records are ignorable, never reach the model, and stay with the log through fork and resume. The browser half that draws them is `client.js`.

## Decision log

Every decision is written to the Host log and appended to `decisionLog` (default `~/.dsh/retry-advisor/decisions.jsonl`) as one JSON line with `outcome` set to `retry`, `give-up`, `analysis-failed`, or `budget-exhausted`. A drop of invalid thinking is a `retry` with `fix` set to `drop-invalid-thinking` and `api` naming the API; the fallback to an ordinary request is a `retry` with `fix` set to `drop-thinking-fallback`. Set `decisionLog` to an empty string to disable the file.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `provider`, `model` | empty | Analysis route; set both or neither. Empty uses the conversation's current model. |
| `reasoningEffort` | empty | Effort of the analysis request. Empty runs the analysis without thinking: the `off` effort when the model offers one, otherwise no effort, which leaves only a route's configured default effort in place. An effort the model does not offer is ignored the same way. |
| `maxTokens` | empty | Output cap of the analysis request, thinking included. Empty uses the analysis model's default, as conversation requests do. |
| `timeoutMs` | `180000` | Deadline of one analysis request. |
| `maxRetriesPerStep` | `3` | Retries this plugin grants per step. |
| `maxDelayMs` | `30000` | Longest wait the analysis may choose. |
| `allowGiveUp` | `true` | Whether the analysis may decide not to retry. |
| `skipCodes` | `[ABORTED]` | Codes never analyzed. |
| `maxFailureChars` | `4000` | Failure-message characters sent to the analysis. |
| `reasonLanguage` | `Simplified Chinese` | Language of `cause` and `reason`. |
| `decisionLog` | `~/.dsh/retry-advisor/decisions.jsonl` | Decision file; empty disables it. |
| `dropInvalidThinking` | `false` | Drop invalid thinking; see above. Volatile, and shown as a switch on the plugin's page. |

Override fields in the profile's patch layer, for example to analyze on a cheaper model at low effort:

```yaml
- id: retry-advisor
  config:
    provider: ccmax
    model: claude-haiku-5-5
    reasoningEffort: low
```

## Model and cost effects

Nothing is added to the model-visible conversation, and the decision records are ignorable log entries. In a conversation that drops invalid thinking, the provider no longer sees the thinking it drops, so the model loses that earlier reasoning; the visible text and tool calls stay. Each analysis is one small request (system prompt plus failure description, about 1–2k input tokens) billed on the analysis route, made only for failures that would otherwise end the turn. By default it runs on the conversation's model without thinking. A granted retry resends the full conversation request.

## Known limitations

- When the analysis runs on the same route that just failed and that route is down, the analysis fails too and the request is not retried.
- The per-step retry count and the set of conversations that drop invalid thinking live in memory and reset when the Host restarts; such a conversation then fails once more and is switched again.
- Dropping reaches only the APIs listed above, on `llm-pi-ai` routes whose SDK sends through the process `fetch`. Elsewhere the repeat failure goes to the ordinary analysis.
- The analysis sees only the failure text, not whether the failed attempt had already streamed output.
- Without the browser half (for example in a headless profile), the records stay in the log and nothing is drawn.

## Tests

`npm test` runs the offline tests. They resolve `@deepseek-ai/schemastery` from `SCHEMASTERY_ENTRY` when set, otherwise from a `deepseek-harness` source checkout next to this directory or next to its repository, otherwise from the devDependency that `npm install` adds.
