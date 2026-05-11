# Gemma Runtime Perf Testing

Last updated: 2026-05-10.

## Current Machine

- MacBook Air, Apple M5, 10 CPU cores, 10 GPU cores, 32 GB unified memory.
- Ollama `0.23.2`.
- oMLX `0.3.8`, OpenAI-compatible API at `http://127.0.0.1:8000/v1`.
- Installed relevant models:
  - `gemma4:e4b`: GGUF, Q4_K_M, about 9.6 GB.
  - `gemma4:e4b-mlx-bf16`: safetensors/MLX-style, about 16 GB.
  - `gemma4:e2b`, `gemma4:26b`, `gemma4:31b`, `gemma4:31b-mlx-bf16`.
  - oMLX `gemma-4-E4B-it-MLX-8bit`, about 8.7 GB active memory in the oMLX dashboard.

## Sources Checked

- Ollama chat/generate API supports `format` for structured output, `think`, `keep_alive`, and runtime `options`; responses include load, prompt eval, and generation timings.
  - https://docs.ollama.com/api/chat
  - https://docs.ollama.com/api/generate
- Google LiteRT GenAI docs say LiteRT-LM is relevant for session cloning, KV-cache management, prompt caching/scoring, and stateful inference.
  - https://ai.google.dev/edge/litert/genai/overview
- Hugging Face exposes `google/gemma-3n-E4B-it-litert-lm`, but the model files require accepting the Gemma license before access. The card lists 32K text context and LiteRT-LM benchmark data.
  - https://huggingface.co/google/gemma-3n-E4B-it-litert-lm
- Public LiteRT artifact tested:
  - https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm

## Harness

- Added `npm run benchmark:gemma`.
- Script: `scripts/benchmark-gemma-runtime.mjs`.
- Outputs:
  - `docs/gemma-runtime-benchmark.latest.json`
  - `docs/gemma-runtime-benchmark.latest.md`
  - optional custom paths via `--outputJson=... --outputMd=...`
- The harness uses the actual SDK path: `createGameAI` plus `ollamaProvider`.
- It tests:
  - cold load probe via Ollama API timings,
  - SDK warmup,
  - greeting,
  - factual response with recent dialogue,
  - long-followup with ten recent dialogue lines,
  - guard threat with reply + mood assessment + action decision,
  - bark refresh versus cache-only hit.

## SDK Changes Made

- `packages/ollama/src/index.ts` now accepts runtime options:
  - `numCtx` -> `num_ctx`
  - `numBatch` -> `num_batch`
  - `numGpu` -> `num_gpu`
  - `numThread` -> `num_thread`
  - `seed`
  - `repeatPenalty` -> `repeat_penalty`
- `packages/ollama/src/index.ts` now accepts `think: boolean | "low" | "medium" | "high"`.
- `packages/ollama/test/index.test.ts` verifies these settings are passed through.
- Added `packages/litert-lm` with `litertLmProvider`.
  - Uses the LiteRT-LM CLI for model discovery and a persistent Python bridge for generation instead of the alpha HTTP server because the bundled server currently initializes `litert_lm.Engine(..., backend=CPU)`.
  - Defaults to GPU backend, `gemma4-e4b-litert`, 4096 KV/cache tokens, and the same temperature/top-p defaults as Ollama.
  - Strips JSON Markdown fences before core schema parsing.
- Added startup runtime selection in the Electron main process:
  - `Ollama Gemma4 E4B`
  - `oMLX Gemma4 E4B MLX 8-bit`
  - `LiteRT-LM Gemma4 E4B`
  - Can be bypassed with `THE_WORLD_AI_STACK=ollama`, `THE_WORLD_AI_STACK=omlx`, or `THE_WORLD_AI_STACK=litert-lm`.
- Added `packages/omlx` with `omlxProvider`.
  - Uses Vercel AI SDK's OpenAI-compatible provider for chat generation instead of owning chat-completions request formatting.
  - Keeps direct `/models` fetches only for health/model discovery.
  - Defaults to `http://127.0.0.1:8000/v1`, API key `1234`, and `gemma-4-E4B-it-MLX-8bit`.
  - Uses AI SDK structured output for `json_schema` mode and still keeps the existing core JSON parsing/validation path as the authority.
- Added install/import scripts:
  - `npm run install:litert-lm`
  - `npm run import:litert-gemma4`

## Key Findings So Far

### Thinking

- `think:false` is required for current structured game calls through Ollama.
- `think:true` caused empty chat content in both tested E4B installs, which triggers SDK fallback:
  - `gemma4:e4b` at 1024 context: all dialogue scenarios fell back.
  - `gemma4:e4b-mlx-bf16` at 1024 context: all dialogue scenarios fell back.
- Recommendation for playable demo right now: keep `think:false` for schema-bound dialogue, mood, action, bark, and overhear recipes.
- Open follow-up: test `think:"low"` explicitly. It may behave differently from `true`, but it should not become the default unless it returns valid schema-bound content.
- Follow-up completed: `think:"low"` at 4096 context also returned empty chat content for all dialogue scenarios. Keep `think:false`.

### Model Format

- `gemma4:e4b` GGUF Q4 is materially faster and more viable than `gemma4:e4b-mlx-bf16` in Ollama on this machine.
- `gemma4:e4b-mlx-bf16`, 1024 context, thinking off:
  - greeting: 12.9s
  - responsive factual: 12.0s
  - guard threat with assessment/action: 24.7s
- `gemma4:e4b`, similar 1024/2048 context, thinking off:
  - greeting: roughly 6.7s to 7.3s
  - responsive factual: roughly 4.6s to 7.1s depending context/run
  - guard threat with assessment/action: roughly 9.4s to 12.1s
- Recommendation: prefer `gemma4:e4b` GGUF Q4 for the demo. Do not use the BF16/MLX install through Ollama for first-interaction latency.

### LiteRT-LM

- Installed `litert-lm==0.11.0` into `/tmp/the-world-litert-venv` for testing only.
- Google gated artifact test:
  - Command attempted: `litert-lm benchmark --from-huggingface-repo google/gemma-3n-E4B-it-litert-lm gemma-3n-E4B-it-int4.litertlm ...`
  - Result: blocked by Hugging Face 401 gated repo. Needs accepted Gemma license plus auth token.
- Public Gemma 4 E4B LiteRT artifact tested:
  - Repo: `litert-community/gemma-4-E4B-it-litert-lm`
  - File: `gemma-4-E4B-it.litertlm`
  - Size on HF page: 3.66 GB.

LiteRT-LM benchmark, 512 prefill tokens, 64 decode tokens:

| Backend | Init | Time to first token | Prefill | Decode |
| --- | ---: | ---: | ---: | ---: |
| CPU | 32.8s | 6.13s | 84.3 tok/s | 17.7 tok/s |
| GPU | 2.93s | 2.43s | 213.2 tok/s | 42.6 tok/s |

LiteRT-LM ad hoc generation, GPU, 4096 max tokens:

- NPC prose prompt completed in 2.19s.
- Threat JSON-ish prompt completed in 2.28s and made the correct hostile/callForHelp decision.
- Caveat: the JSON-ish output was wrapped in Markdown fences, so this is not yet a replacement for Ollama structured output. It is strong evidence that a LiteRT-LM provider could be much faster if we add prompt/JSON handling and/or use a compatible serving API.
- SDK provider smoke test after implementation:
  - `litertLmProvider` health found imported `gemma4-e4b-litert`.
  - Tiny schema prompt returned `{"text":"ready"}` in 4.8s.
  - Real `GameAI` NPC dialogue call returned valid schema-bound dialogue in 6.0s with no fallback.
- Follow-up implementation note: the original provider used `litert-lm run` per SDK call, which made in-game LiteRT-LM feel awful because every call paid process/engine startup. It now uses a persistent Python bridge that keeps a GPU LiteRT engine alive.
- Persistent bridge timing:
  - warmup: about 1.75s
  - tiny repeated schema calls after warmup: about 0.7s
  - full `GameAI` NPC dialogue prompt: about 7.9s to 8.5s
- Conclusion: LiteRT-LM is promising for a smaller prompt path, but the current full schema-bound SDK prompt is still too heavy to make LiteRT-LM obviously better than Ollama in-game.

Recommendation: keep Ollama as the playable default for now because it has more benchmark coverage, but use startup selection to test the new LiteRT-LM provider in-game. LiteRT-LM GPU has the first-token and decode profile we want.

### oMLX

- Added an SDK provider path for the running oMLX server instead of treating it as an Ollama model variant.
- Live smoke test against `gemma-4-E4B-it-MLX-8bit` on 2026-05-10:
  - health check listed the model from `/models`;
  - tiny schema-guided prompt returned `{"text":"ready"}`;
  - latency was about 550ms for 168 prompt tokens and 5 output tokens with AI SDK structured output enabled.
- oMLX dashboard at the time of testing reported:
  - prompt processing around 11.8 tok/s;
  - generation around 24.3 tok/s;
  - active model memory around 8.7 GB.
- This is not yet a full in-game benchmark. The tiny prompt result is good enough to prove the provider path, startup selection, API key/base URL defaults, and AI SDK integration.

Recommendation: use the new startup option to compare oMLX in-game against Ollama on real dialogue, ambient, and event prompts. Keep Ollama as the default until the full scenario harness shows oMLX is consistently faster for realistic prompts.

### Realistic Context Size

Treat 512 and 1024 as lower-bound stress tests, not recommendations. This is a dynamic town, not coding, but it still needs enough room for persona, scene, policy, recent dialogue, and schema.

Realistic sweep for `gemma4:e4b`, thinking off:

| Context | Greeting | Factual | Long Follow-up | Guard Threat + Analysis | Validity |
| --- | ---: | ---: | ---: | ---: | --- |
| 2048 | 7.3s | 7.1s fallback | 7.6s fallback | 10.3s | weak |
| 4096 | 7.0s | 5.5s | 6.3s | 12.1s | best so far |
| 8192 | 10.3s | 8.6s | 12.1s fallback | 15.8s | too slow/less reliable |

Recommendation so far: use `num_ctx: 4096`, `num_batch: 128`, `think:false`.

Why: 2048 produced malformed JSON in ordinary game-dialogue cases, while 8192 increased latency and still failed the long-followup once. 4096 handled the realistic long follow-up cleanly in this run.

### Caching

- SDK session cache works for ambient bark calls:
  - refresh calls were about 1.9s to 2.7s on GGUF E4B.
  - cache-only hit was 0ms in trace and effectively instant wall time.
- Follow-up startup timing showed individual ambient generations are much slower in realistic current prompts:
  - Ollama `gemma4:e4b`: warmup 10.1s, bark 10.3s, overhear 10.7s.
  - LiteRT-LM persistent bridge: warmup 1.9s, bark 11.8s, overhear 12.6s.
- Do not block the loading screen on the full ambient cache. Startup now gates only runtime/model warmup, then schedules a small nearby ambient cache in the background after the player enters.
- Initial ambient startup cache is capped at 6 jobs. The old 24-job boot queue could make the player wait several minutes.
- Recommendation: keep ambient and movement-adjacent systems cache-first/pre-generated.
- Do not cache first-time player dialogue broadly unless the cache key is intentionally scenario-specific; player dialogue needs real model judgment.

### Demo Runtime Wiring

- `apps/the-world/src/main/runtime.ts` now opts into the current best Ollama defaults:
  - `keepAlive: "30m"`
  - `temperature: 0.55`
  - `topP: 0.9`
  - `think: false`
  - `numCtx: 4096`
  - `numBatch: 128`
- Runtime overrides:
  - `THE_WORLD_KEEP_ALIVE`
  - `THE_WORLD_TEMPERATURE`
  - `THE_WORLD_TOP_P`
  - `THE_WORLD_THINK=false|true|low|medium|high`
  - `THE_WORLD_NUM_CTX`
  - `THE_WORLD_NUM_BATCH`
  - `THE_WORLD_NUM_GPU`
  - `THE_WORLD_NUM_THREAD`

## Current Preferred Config

For `gemma4:e4b` through Ollama as the stable playable path:

```ts
ollamaProvider({
  model: 'gemma4:e4b',
  keepAlive: '30m',
  temperature: 0.55,
  topP: 0.9,
  think: false,
  runtimeOptions: {
    numCtx: 4096,
    numBatch: 128
  }
})
```

Game-side recommendation:

- Start model warmup when Electron main starts.
- Keep model alive across play with `keep_alive: 30m`.
- Pregenerate/cache ambient barks and overheard exchanges.
- On player approach or hover, begin a lightweight interaction warmup if the UI can do that without committing dialogue.
- First visible NPC response should be a single creative dialogue call.
- Mood/action analysis can happen after the text response, or only for risky input, if we want faster perceived response.

## Open Work

- Run a repeat pass for the current preferred config to check variance.
- Test whether `think:true` or `think:"low"` can work in a separate non-schema recipe. Do not use it in schema-bound paths right now.
- Test whether smaller schemas or shorter prompt instructions improve JSON reliability at 2048/4096 without reducing model judgment.
- Add a benchmark mode that streams first token time; current SDK path uses non-streaming JSON, so it measures complete response latency.
- For Google's gated Gemma 3n LiteRT artifact, retry after Hugging Face auth/license acceptance is available.
- Run a broader in-game LiteRT-LM pass for barks, overhear, mood assessment, and action decisions. The provider works for basic schema-bound dialogue, but the full playable path still needs more data.
- Decide whether the SDK should expose an official interaction policy like:
  - `fastTextFirst`: reply now, run mood/action after.
  - `fullDecision`: reply + assessment + action before renderer resolves.
  - `riskOnlyDecision`: deterministic narrow risk screen decides whether to run assessment/action.

## 2026-05-10 Three-Runtime Clean Benchmark

Command:

```sh
npm run benchmark:gemma -- --quick=true --repetitions=1 --timeoutMs=120000 --models=gemma4:e4b --omlxModels=gemma-4-E4B-it-MLX-8bit --litertModels=gemma4-e4b-litert --configs=ollama-ctx4096-q4-thinkOff:ctx=4096:batch=128:think=false --omlxConfigs=omlx-json_schema --litertConfigs=litert-gpu-ctx4096:backend=gpu:ctx=4096
```

Clean run artifacts:

- `docs/gemma-runtime-benchmark.latest.json`
- `docs/gemma-runtime-benchmark.latest.md`

Runtime isolation notes:

- Ollama benchmark calls the local unload endpoint before each direct probe with `keep_alive: 0`.
- LiteRT-LM benchmark closes the persistent bridge after each config so it does not keep model memory across later comparisons.
- oMLX is measured as a warm local server. The OpenAI-compatible endpoint does not expose a model-unload call, so this is not a true cold-load number.

Bug found and fixed:

- The realistic long-followup scenario could exceed the old `npcDialogueRecipe.maxTokens = 220` budget and produce truncated malformed JSON on `gemma4:e4b` at `num_ctx:4096`.
- Increased the dialogue recipe cap to `320`. The clean three-runtime pass completed with all scenarios passing and no fallbacks.

### Clean Results

| Scenario | Winner | Time | Notes |
| --- | --- | ---: | --- |
| Greeting | oMLX `gemma-4-E4B-it-MLX-8bit` | 5.85s | Ollama was 7.86s, LiteRT-LM was 11.90s. |
| Responsive factual dialogue | Ollama `gemma4:e4b` GGUF Q4 | 4.73s | oMLX was 6.23s, LiteRT-LM was 13.63s. |
| Long follow-up dialogue | oMLX `gemma-4-E4B-it-MLX-8bit` | 4.92s | Ollama was 5.88s, LiteRT-LM was 14.54s. |
| Guard threat with mood/action assessment | Ollama `gemma4:e4b` GGUF Q4 | 11.03s | oMLX total was 15.75s, LiteRT-LM was 26.06s. oMLX's assessment leg was faster, but its initial reply leg was slower. |
| Ambient bark refresh | oMLX `gemma-4-E4B-it-MLX-8bit` | 1.53s | Ollama was 2.49s, LiteRT-LM was 5.75s. Cache hit was effectively instant for all runtimes. |
| Cold/warm probe | oMLX warm server | 1.41s | Ollama true unload probe was 6.27s. LiteRT-LM warm bridge probe was 5.62s. |

### Current Preference

- Default playable path remains Ollama `gemma4:e4b` GGUF Q4 with `num_ctx:4096`, `num_batch:128`, and `think:false`.
- oMLX is now a strong alternate for low-risk dialogue, long single-turn dialogue, and ambient pregeneration. It is not the overall winner yet because full assessed hostile turns are slower.
- LiteRT-LM should remain experimental. It passed the clean benchmark, but it was slower in every tested gameplay scenario.
- Do not use `think:true` in the schema-bound playable path. Exploratory runs still produced empty/fallback responses with current Gemma/Ollama settings.
