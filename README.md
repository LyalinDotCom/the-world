# The World

The World is a prototype for **AI middleware for games** plus a playable Electron test game. It is meant to demonstrate how local LLMs can behave like controlled game systems instead of loose chatbots.

The core idea is:

> Dynamic game text without surrendering control of your game.

This repo shows a small but working slice of that idea: a game developer defines NPCs, scene context, lore, policies, and output schemas; the runtime compiles prompts, calls a local model through Ollama, validates or repairs the result, records memory, and returns typed game events the game can choose to accept.

## What This Demonstrates

- A game-native TypeScript API for NPC dialogue, ambient barks, and overheard NPC-to-NPC exchanges.
- Schema-first LLM output so dialogue returns structured `DialogueTurn` objects, not arbitrary prose.
- A provider boundary where Ollama/Gemma is one backend, not the whole product.
- Safe Electron integration that keeps model access in the main process and exposes a narrow IPC bridge to the renderer.
- Model warmup on startup so the first real conversation is less likely to pay the full local model-load cost.
- A procedural 2D world with trees, hills, paths, large explorable space, generated NPCs, Talk interaction, free-text replies, and a Goodbye flow.
- A dev trace panel that surfaces provider/model/cache/fallback behavior while playing.

This is not trying to be a finished RPG yet. It is a technical demo of the runtime shape: how a game engine can ask an LLM for controlled, typed, lore-aware behavior during play.

The repo contains:

- `@game-llm/core`: game-native TypeScript runtime concepts: NPCs, schema-bound dialogue turns, prompt compilation, memory, recipes, cache, debug traces, and a mock provider.
- `@game-llm/ollama`: Ollama adapter with model listing, health checks, JSON-schema generation, and a low-end Gemma-friendly default.
- `@game-llm/electron`: safe Electron IPC helpers that keep model access in the main process.
- `apps/the-world`: a 2D procedural exploration demo with trees, hills, paths, NPCs, overheard barks, and natural-language conversations.

## Architecture

```txt
packages/core
  Game concepts: NPC definitions, prompt compiler, memory, recipes,
  schemas, validation, repair, fallback, mock provider.

packages/ollama
  Local model adapter: health checks, installed-model awareness,
  warmup, structured JSON calls, Gemma-friendly thinking control.

packages/electron
  IPC bridge: renderer can request health, warmup, dialogue, bark,
  and overhear calls without direct arbitrary model access.

apps/the-world
  Electron shell and canvas renderer for the playable demo.
```

The Electron main process owns the AI runtime. The renderer owns player movement, canvas drawing, NPC proximity detection, and UI. When the player talks to an NPC, the renderer sends a narrow structured request over IPC; the main process returns a typed dialogue result.

## Run

```sh
npm install
npm start
```

`npm start` builds the packages and launches the Electron shell.

For renderer development with Vite:

```sh
npm run dev
```

## Model Runtime

The demo defaults to `gemma4:e4b`, the second-smallest installed Gemma model on this machine at implementation time. That can be overridden:

```sh
THE_WORLD_MODEL=gemma4:e2b npm start
```

The Ollama adapter sends `think: false` for short game calls. This matters for local Gemma variants because otherwise the model can spend the output budget in a thinking channel before producing JSON.

On startup, the app:

1. Creates the Electron window immediately.
2. Registers the AI IPC bridge.
3. Warms the selected local model in the background.
4. Shows model/provider status in the HUD.

If you open the renderer directly in a browser, it uses the browser fallback mock bridge. The real Ollama/Gemma path is available through Electron.

## Playing The Demo

- Move with `WASD` or arrow keys.
- Approach an NPC and click `Talk`, or press `E`.
- Type natural language into the dialogue box.
- Click `Goodbye` to let the NPC end the conversation.
- Stay near NPCs to see ambient barks and overheard exchanges.
- Watch the runtime trace panel for model, cache, fallback, and raw output details.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Useful live checks:

```sh
npm start
```

Expected Electron startup log includes:

```txt
The World: renderer loaded.
The World: warmup ready (ollama gemma4:e4b)
```

## Current Scope

Implemented now:

- Procedural terrain, roads, hills, trees, and generated NPCs.
- NPC Talk interaction with two-way text.
- NPC-controlled conversation ending through `shouldEndConversation`.
- Ambient barks and overheard two-NPC exchanges.
- Local Ollama/Gemma structured generation.
- Warmup API and startup warmup.
- Schema validation, repair, and fallback.
- Mock provider for tests and browser-only renderer previews.

Good next steps:

- Add YAML authoring for NPCs, recipes, lore, and policies.
- Add lore retrieval with embeddings.
- Add tool calling for read-only game-state queries and proposed game events.
- Add richer devtools with prompt replay and schema failure inspection.
- Package the Electron app with a proper icon/name instead of running through dev Electron.
