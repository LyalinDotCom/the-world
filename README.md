# The World

The World is a greenfield prototype for **AI middleware for games** plus a playable Electron test game.

The repo contains:

- `@game-llm/core`: game-native TypeScript runtime concepts: NPCs, schema-bound dialogue turns, prompt compilation, memory, recipes, cache, debug traces, and a mock provider.
- `@game-llm/ollama`: Ollama adapter with model listing, health checks, JSON-schema generation, and a low-end Gemma-friendly default.
- `@game-llm/electron`: safe Electron IPC helpers that keep model access in the main process.
- `apps/the-world`: a 2D procedural exploration demo with trees, hills, paths, NPCs, overheard barks, and natural-language conversations.

## Run

```sh
npm install
npm run dev
```

The demo defaults to `gemma4:e4b`, the second-smallest installed Gemma model on this machine at implementation time. Override it with:

```sh
THE_WORLD_MODEL=gemma4:e2b npm run dev
```

If Ollama or the selected model is unavailable, the game still loads using the mock provider so movement, NPC discovery, dialogue UI, and devtools can be tested.
