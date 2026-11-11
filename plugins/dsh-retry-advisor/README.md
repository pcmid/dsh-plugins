# AI retry advisor

`@pcmid/dsh-retry-advisor` decides what to do with a failed model request after every built-in recovery handler has declined. It asks a model why the request failed and whether resending it can succeed, and shows the decision in the conversation. If the analysis itself fails, the failure stays terminal and the turn ends as it did before.

## Behavior

The plugin listens on `agent/request-error` and first calls `next()`, so these handlers always go first:

- `dsh-llm-retry` retries the route's transient codes (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` by default).
- Context compaction handles `CONTEXT_WINDOW_EXCEEDED`; image offload handles `IMAGE_OFFLOAD_REQUIRED`.

Only when they all leave the failure terminal does the advisor act:

1. Codes in `skipCodes` (default `ABORTED`) stay terminal.
2. When this plugin has already granted `maxRetriesPerStep` retries in the same step, the failure stays terminal.
3. Otherwise one analysis request goes to the configured model, or to the conversation's current model when none is configured. It uses the conversation's current reasoning effort unless `reasoningEffort` is set, and the model's default output cap unless `maxTokens` is set. It receives the failure code, HTTP status, retry-after hint, the failure message (head and tail, up to `maxFailureChars`), and the earlier failures and decisions in this step. It does not receive the conversation.
4. The answer is one JSON line: `retry`, `delayMs`, `cause`, and `reason`. On `retry: true` the plugin waits `delayMs` (capped by `maxDelayMs`) and resends the identical request. On `retry: false` the failure stays terminal. With `allowGiveUp: false` the analysis only chooses the delay.
5. A failed, timed-out (`timeoutMs`), or unparsable analysis leaves the failure terminal.

A retry resends the same request; the plugin cannot change the messages, tools, or model.

The analysis prompt treats a provider safety, usage-policy, or terms-of-service block (for example `This request was blocked as it seems to violate … Terms of Service`) as worth one retry: these classifiers also judge the output being generated, so on ordinary software work they often fire falsely and a resend that samples new output passes. The same block repeated in one step is not retried again.

## Decisions in the conversation

Each failure the advisor handles gets one row in the Chat view, in the failed Turn and outside its process disclosure, so it stays visible when the Turn is folded:

| Row | Meaning |
| --- | --- |
| Analyzing the failure | The analysis request is running. It reads as cancelled when the Turn stops first. |
| Retrying in N seconds (attempt i/max) | The analysis chose to resend; the row shows the cause and reason. |
| Not retrying | The analysis judged that a resend fails the same way; the row shows the cause and reason. |
| Analysis failed | The analysis request failed, timed out, or answered unusably; the row shows the error. |
| Retries used up | This step already used `maxRetriesPerStep` retries. |

Details under each row name the original failure code and message and the analysis model and effort. The rows come from `plugin:retry-advisor/decision` records in the Session log: one when the analysis starts and one with the outcome, both carrying the same `id` and the complete state. The records are ignorable, never reach the model, and stay with the log through fork and resume. The browser half that draws them is `client.js`.

## Decision log

Every decision is written to the Host log and appended to `decisionLog` (default `~/.dsh/retry-advisor/decisions.jsonl`) as one JSON line with `outcome` set to `retry`, `give-up`, `analysis-failed`, or `budget-exhausted`. Set `decisionLog` to an empty string to disable the file.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `provider`, `model` | empty | Analysis route; set both or neither. Empty uses the conversation's current model. |
| `reasoningEffort` | empty | Effort of the analysis request. Empty uses the conversation's current effort. An effort the analysis model does not offer is dropped and the model default applies. |
| `maxTokens` | empty | Output cap of the analysis request, thinking included. Empty uses the analysis model's default, as conversation requests do. |
| `timeoutMs` | `180000` | Deadline of one analysis request. |
| `maxRetriesPerStep` | `3` | Retries this plugin grants per step. |
| `maxDelayMs` | `30000` | Longest wait the analysis may choose. |
| `allowGiveUp` | `true` | Whether the analysis may decide not to retry. |
| `skipCodes` | `[ABORTED]` | Codes never analyzed. |
| `maxFailureChars` | `4000` | Failure-message characters sent to the analysis. |
| `reasonLanguage` | `Simplified Chinese` | Language of `cause` and `reason`. |
| `decisionLog` | `~/.dsh/retry-advisor/decisions.jsonl` | Decision file; empty disables it. |

Override fields in the profile's patch layer, for example to analyze on a cheaper model at low effort:

```yaml
- id: retry-advisor
  config:
    provider: ccmax
    model: claude-haiku-5-5
    reasoningEffort: low
```

## Model and cost effects

Nothing is added to the model-visible conversation or its prompt cache; the decision records are ignorable log entries. Each analysis is one small request (system prompt plus failure description, about 1–2k input tokens) billed on the analysis route, made only for failures that would otherwise end the turn. By default it runs on the conversation's model and effort, so a high-effort conversation spends more thinking tokens and time on the analysis. A granted retry resends the full conversation request.

## Known limitations

- When the analysis runs on the same route that just failed and that route is down, the analysis fails too and the request is not retried.
- The per-step retry count lives in memory and resets when the Host restarts.
- The analysis sees only the failure text, not whether the failed attempt had already streamed output.
- Without the browser half (for example in a headless profile), the records stay in the log and nothing is drawn.

## Tests

`npm test` runs the offline tests. They resolve `@deepseek-ai/schemastery` from `SCHEMASTERY_ENTRY` when set, otherwise from a `deepseek-harness` source checkout next to this directory or next to its repository, otherwise from the devDependency that `npm install` adds.
