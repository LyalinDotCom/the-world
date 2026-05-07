import type { ChatMessage, DialogueRequest, GameAIPolicies, GameAIWorldConfig, NpcDefinition, OverhearRequest, PromptCompileContext } from './types.js';

export function worldSystemPrompt(world: GameAIWorldConfig, policies: GameAIPolicies): string {
  return [
    'You are game AI middleware. Return only JSON matching the requested schema.',
    'You are not a free-form chatbot. You create controlled game content.',
    `World: ${world.name ?? world.id}.`,
    world.styleGuide ? `Style guide: ${world.styleGuide}` : 'Style guide: grounded, concise, sensory, no modern slang unless the NPC persona allows it.',
    world.lore?.length ? `Canon lore:\n${world.lore.map((line) => `- ${line}`).join('\n')}` : 'Canon lore: the local world state provided in the request is authoritative.',
    policies.canonOnly ? 'Canon policy: do not invent major factions, towns, gods, quest outcomes, rewards, or player actions.' : 'Canon policy: minor local color is allowed if it does not affect game state.',
    policies.noQuestMutationWithoutTool ?? true ? 'Game integrity: propose game-state changes as events only; never claim rewards, inventory, or quest completion happened.' : '',
    policies.noRewardCreation ?? true ? 'Rewards: do not create money, items, reputation, or quest rewards in dialogue.' : '',
    `Content rating: ${policies.contentRating ?? 'T'}.`
  ].filter(Boolean).join('\n');
}

export function compileDialoguePrompt(npc: NpcDefinition, request: DialogueRequest, ctx: PromptCompileContext): ChatMessage[] {
  const persona = npc.persona;
  const memory = ctx.memory.length ? ctx.memory.map((line) => `- ${line}`).join('\n') : '- No important prior memory.';
  const playerFacts = request.player?.knownFacts?.length ? request.player.knownFacts.map((fact) => `- ${fact}`).join('\n') : '- None.';
  const recentDialogue = request.recentDialogue?.length
    ? request.recentDialogue.slice(-8).map((line) => `${line.speaker}: ${line.text}`).join('\n')
    : 'None.';
  return [
    {
      role: 'system',
      content: worldSystemPrompt(ctx.world, ctx.policies)
    },
    {
      role: 'user',
      content: [
        'Recipe: npc.dialogue.turn',
        'Return one JSON object with text, emotion, mood, attitudeDelta, willTalkAgain, animationHint, events, memoryWrites, safetyFlags, and optional shouldEndConversation/refusalReason.',
        'Keep the NPC reply to 1-3 short sentences. The NPC may end the conversation if the player says goodbye, is rude, scary, insulting, or the scene demands it.',
        'Mood is the NPC mood after replying: calm, curious, wary, busy, lonely, cheerful, afraid, angry, offended, or hostile.',
        'attitudeDelta is how this exact player message changed the NPC attitude from -30 to 30.',
        'willTalkAgain is whether this NPC is still willing to talk to this player later in this play session.',
        'If the player is very insulting, threatening, or repeatedly rude, set mood to offended/angry/hostile, set shouldEndConversation true, set willTalkAgain false, and include refusalReason.',
        'If mood is angry, afraid, offended, or hostile, you may set shouldEndConversation true even if the player did not say goodbye.',
        'Do not repeat your previous reply. If the player asks "what?" or seems confused, clarify what you just meant in plainer words.',
        '',
        `NPC id: ${npc.id}`,
        `NPC name: ${persona.name}`,
        `Role: ${persona.role}`,
        `Mood: ${persona.mood ?? 'calm'}`,
        persona.traits?.length ? `Traits: ${persona.traits.join(', ')}` : '',
        persona.speechStyle ? `Speech style: ${persona.speechStyle}` : '',
        persona.goals?.length ? `Goals: ${persona.goals.join('; ')}` : '',
        persona.knows?.length ? `Knows: ${persona.knows.join('; ')}` : '',
        persona.doesNotKnow?.length ? `Does not know: ${persona.doesNotKnow.join('; ')}` : '',
        persona.rules?.length ? `NPC rules:\n${persona.rules.map((rule) => `- ${rule}`).join('\n')}` : '',
        '',
        `Scene: ${JSON.stringify(request.scene)}`,
        `Player: ${JSON.stringify(request.player ?? {})}`,
        `Relationship: ${request.relationship ?? 'stranger'}`,
        `Current NPC session state: ${JSON.stringify(request.npcState ?? {
          mood: persona.mood ?? 'calm',
          disposition: 0,
          willTalkAgain: true
        })}`,
        `Relevant memory:\n${memory}`,
        `Recent dialogue:\n${recentDialogue}`,
        `Player known facts:\n${playerFacts}`,
        '',
        `Player says: ${request.playerText}`,
        '',
        'Memory writes should capture only durable facts worth remembering. Safety flags are usually empty.'
      ].filter(Boolean).join('\n')
    }
  ];
}

export function compileBarkPrompt(npc: NpcDefinition, ctx: PromptCompileContext, sceneJson: string, reason?: string): ChatMessage[] {
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: npc.bark',
        'Return one JSON object with text, emotion, and safetyFlags.',
        'For ordinary ambient speech, safetyFlags must be exactly [].',
        'Write one short ambient line this NPC might say aloud near the player. No exposition dump.',
        'Output shape: {"text":"short line","emotion":"neutral","safetyFlags":[]}',
        `NPC id: ${npc.id}`,
        `NPC name: ${npc.persona.name}`,
        `Role: ${npc.persona.role}`,
        `Mood: ${npc.persona.mood ?? 'calm'}`,
        npc.persona.speechStyle ? `Speech style: ${npc.persona.speechStyle}` : '',
        `Scene: ${sceneJson}`,
        reason ? `Reason: ${reason}` : ''
      ].filter(Boolean).join('\n')
    }
  ];
}

export function compileOverhearPrompt(npc: NpcDefinition, request: OverhearRequest, ctx: PromptCompileContext): ChatMessage[] {
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: npc.overhear',
        'Return one JSON object with lines and safetyFlags.',
        'For ordinary overheard speech, safetyFlags must be exactly [].',
        'Write exactly two overheard lines between the NPCs. The player is nearby but not addressed.',
        'Each line must be under 16 words. Do not reveal secrets.',
        'Output shape: {"lines":[{"npcId":"npc.a","text":"short line","emotion":"neutral"},{"npcId":"npc.b","text":"short reply","emotion":"neutral"}],"safetyFlags":[]}',
        `NPC A: ${npc.id} ${npc.persona.name}, ${npc.persona.role}, mood ${npc.persona.mood ?? 'calm'}`,
        `NPC B: ${request.otherNpc.id} ${request.otherNpc.persona.name}, ${request.otherNpc.persona.role}, mood ${request.otherNpc.persona.mood ?? 'calm'}`,
        `Scene: ${JSON.stringify(request.scene)}`,
        request.topic ? `Topic: ${request.topic}` : 'Topic: nearby travel, weather, rumors, or work.',
        ctx.memory.length ? `Relevant memory:\n${ctx.memory.map((line) => `- ${line}`).join('\n')}` : ''
      ].filter(Boolean).join('\n')
    }
  ];
}
