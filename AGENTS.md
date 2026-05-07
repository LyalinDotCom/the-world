# The World: Agent North Star

The World is a **Gemma-in-games showcase**. Treat it as a prototype for game-native AI middleware, not as a generic canvas game and not as an Ollama wrapper demo.

The long-term goal is to prove that local Gemma-class models can bring a procedural game world to life while the game keeps control of state, lore, safety, and progression.

## Soul Of The Project

This project exists to learn what Gemma can and cannot do in an actual game loop. Do not lose sight of that.

- The playable demo should test the model, not hide it. If Gemma gives a weak, vague, wrong, slow, or malformed answer, make that visible through the conversation, diagnostics, traces, tests, or notes. Do not silently replace it with a better handcrafted answer.
- The SDK should make model behavior controllable, observable, and safe; it should not become a pile of keyword scripts pretending to be AI.
- Fallbacks are for technical failure states and tests, not for making the playable demo look smarter than the model is.
- When the model fails at an intended capability, prefer improving the prompt, schema, context, recipe split, retrieval, model settings, diagnostics, or documentation of the failure before adding deterministic game logic.
- Deterministic guardrails are acceptable only for game integrity and runtime safety: schema validation, cancellation, cache policy, no direct state mutation, and narrow policy thresholds that a real SDK user would expect. They must be explicit, configurable when reasonable, and visible as SDK policy rather than hidden game behavior.
- Do not add broad keyword trees for social judgment, lore answers, insults, persuasion, fear, secrets, or relationship handling. Those are exactly the model capabilities this demo is meant to evaluate.
- If a change reduces the amount of real model judgment in the playable path, call that out in the PR/commit notes and justify why it is necessary for SDK control rather than demo polish.
- The best outcome is not that every interaction looks perfect. The best outcome is that developers can see where Gemma is powerful, where it struggles, and how a light SDK can expose, constrain, and measure that honestly.

## Product Direction

- The player should feel like the world is alive before they interact with it.
- NPCs should have local context, private motives, short memories, and social boundaries.
- Some NPCs are approachable and can have natural two-way conversations.
- Some NPCs are in groups, already talking, and refuse interruption.
- Ambient barks and overheard conversations should reveal mood, rumors, and place without becoming exposition dumps.
- Ambient flow is a game system: cap visible ambient speakers, rotate NPC pairs/topics with cooldowns, prefer short NPC-to-NPC meetups over random solo chatter, and keep announcements rare.
- The map should feel authored enough to navigate: fixed bounds, named towns, named woods, roads, walking spaces, and a minimap.
- Diagnostics should make the local model/runtime cost visible, including model status, latency/fallback traces, FPS, CPU load, GPU load, memory pressure, and optional play-session perf logs.
- Generated content must stay game-safe: typed outputs, validation, repair, policy checks, and no direct authoritative state mutation.

## Non-Negotiables

- No fake renderer fallback for conversations. If the Electron/Gemma bridge is broken, show the failure plainly.
- The demo exists to show Gemma working in games. Canned dialogue is only acceptable in tests or explicit mock mode, not as the playable default.
- Keep the Electron main process as the owner of model access. The renderer should use a narrow IPC bridge.
- Prefer schema-bound results and typed events over parsing prose.
- Do not let the model grant rewards, mutate inventory, complete quests, or invent major canon facts directly.
- Movement-adjacent ambient life should be cache-first or pre-generated. Do not let walking around spam local Gemma calls.

## Architecture Guardrails

This repo should demonstrate an SDK-backed game architecture, not a pile of demo code. When adding features, keep game systems, SDK runtime logic, rendering, and Electron plumbing in separate modules.

- `packages/core` owns game-native AI concepts: recipes, schemas, prompt compilation, validation, repair, memory, caching, mood/action analysis, and provider-neutral runtime behavior.
- `packages/ollama` owns only the Ollama adapter: request formatting, health checks, model options, structured output calls, streaming, embeddings, and model warmup.
- `packages/electron` owns the safe IPC bridge shape. All renderer-to-main payloads should be runtime validated before they reach `GameAI`.
- `apps/the-world/src/main` owns app lifecycle, windows, diagnostics sampling, performance logging, and the concrete SDK runtime wiring for this demo.
- `apps/the-world/src/renderer` owns canvas input, rendering, camera, HUD, and game presentation. It should call narrow controllers/systems rather than embedding every rule in `main.ts`.

Use these file-size tripwires:

- Around 500 lines: ask whether the file is taking on a second responsibility.
- Around 800 lines: extract before adding more feature work unless the file is intentionally generated or data-only.
- Over 1,000 lines: treat as architecture debt. Do not add major logic there without also extracting a module.

Preferred renderer modules:

- `gameLoop.ts`: fixed update/render scheduling, frame timing, pause state.
- `collision.ts`: map bounds and building blockers. Keep it pure and unit-tested.
- `ambientDirector.ts`: NPC meetups, announcements, ambient cooldowns, visible-speaker caps, and cache-first flow control.
- `dialogueController.ts`: conversation lifecycle, walk-away close behavior, thinking state, mood/action results, and session refusal state.
- `diagnosticsHud.ts`: FPS, model name, runtime status, CPU/GPU/memory panels, tab state, expand/collapse state.
- `worldView.ts`: camera transforms, minimap projection, map markers, and visible-world calculations.
- `rendering/*`: drawing houses, landmarks, roads, NPCs, bubbles, constables, HUD overlays, and debug layers.

Preferred Electron main modules:

- `window.ts`: BrowserWindow creation, dev/prod loading, app menu behavior.
- `runtime.ts`: concrete `createGameAI` config, model warmup, lore, recipes, and IPC handler registration for AI calls.
- `diagnostics.ts`: CPU, GPU, memory, model status, and machine capability sampling.
- `perfLog.ts`: optional session telemetry logging for FPS, CPU/GPU, interactions, cache hits, and model calls.

Feature placement rules:

- If a behavior is part of the SDK promise, implement it in `packages/core` first and let the demo opt into it.
- If a behavior is only demo staging, put it in `apps/the-world` and keep it out of SDK packages.
- If logic can be tested without canvas, Electron, or Ollama, extract it and add a unit test.
- When adding or changing schemas, update both Zod schemas and JSON schemas, then add or update parity tests.
- When adding IPC methods, validate payloads at runtime in `packages/electron`; do not cast untrusted renderer payloads directly into core types.
- When adding model calls, make the cache/pre-generation behavior explicit. Ambient or movement-adjacent systems must not issue unbounded realtime calls.
- Keep model analysis tasks small and separate for weaker local models: one call for the creative reply, one for mood/state assessment, and one for action decisions when needed.
- Do not hide broken AI behind renderer-only fallback dialogue in the playable demo. Broken model/runtime paths should be visible in diagnostics.

## Current Demo Priorities

1. Make conversations genuinely responsive to recent dialogue.
2. Make the world feel lived in: wandering NPCs, houses, groups, private conversations, barks, and overheard exchanges.
3. Keep ambient life readable and performant: no popup spam, cache-first speech, staged meetups, visible FPS, and diagnostics for flow control.
4. Make runtime state visible: provider, model, bridge status, latency/fallback/repair trace, FPS, CPU usage, GPU usage, memory capacity, and optional telemetry logs.
5. Keep the local model warm and use low-latency prompts suitable for short game interactions.
6. Keep navigation understandable: spawn near a town, show the player on a minimap, and block leaving the current prototype map cleanly.

## Good Next Steps

- Add YAML/JSON authoring for NPCs, recipes, lore, policies, and settlements.
- Add generated settlements with named houses, campfires, signs, gardens, and work areas.
- Add relationship state so repeated interactions change NPC tone.
- Add tool calling for read-only game-state queries and proposed actions.
- Add lore retrieval with embeddings and source traces.
- Add a real devtools panel for prompt replay, schema repair inspection, and memory review.
