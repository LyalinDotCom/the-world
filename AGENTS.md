# The World: Agent North Star

The World is a **Gemma-in-games showcase**. Treat it as a prototype for game-native AI middleware, not as a generic canvas game and not as an Ollama wrapper demo.

The long-term goal is to prove that local Gemma-class models can bring a procedural game world to life while the game keeps control of state, lore, safety, and progression.

## Product Direction

- The player should feel like the world is alive before they interact with it.
- NPCs should have local context, private motives, short memories, and social boundaries.
- Some NPCs are approachable and can have natural two-way conversations.
- Some NPCs are in groups, already talking, and refuse interruption.
- Ambient barks and overheard conversations should reveal mood, rumors, and place without becoming exposition dumps.
- The map should feel authored enough to navigate: fixed bounds, named towns, named woods, roads, walking spaces, and a minimap.
- Generated content must stay game-safe: typed outputs, validation, repair, policy checks, and no direct authoritative state mutation.

## Non-Negotiables

- No fake renderer fallback for conversations. If the Electron/Gemma bridge is broken, show the failure plainly.
- The demo exists to show Gemma working in games. Canned dialogue is only acceptable in tests or explicit mock mode, not as the playable default.
- Keep the Electron main process as the owner of model access. The renderer should use a narrow IPC bridge.
- Prefer schema-bound results and typed events over parsing prose.
- Do not let the model grant rewards, mutate inventory, complete quests, or invent major canon facts directly.

## Current Demo Priorities

1. Make conversations genuinely responsive to recent dialogue.
2. Make the world feel lived in: wandering NPCs, houses, groups, private conversations, barks, and overheard exchanges.
3. Make runtime state visible: provider, model, bridge status, latency/fallback/repair trace.
4. Keep the local model warm and use low-latency prompts suitable for short game interactions.
5. Keep navigation understandable: spawn near a town, show the player on a minimap, and block leaving the current prototype map cleanly.

## Good Next Steps

- Add YAML/JSON authoring for NPCs, recipes, lore, policies, and settlements.
- Add generated settlements with named houses, campfires, signs, gardens, and work areas.
- Add relationship state so repeated interactions change NPC tone.
- Add tool calling for read-only game-state queries and proposed actions.
- Add lore retrieval with embeddings and source traces.
- Add a real devtools panel for prompt replay, schema repair inspection, and memory review.
