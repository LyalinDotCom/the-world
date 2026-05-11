import type { AreaEventRequest, BarkRequest, ChatMessage, DialogueMoodAssessment, DialogueRequest, DialogueTurn, GameAIPolicies, GameAIWorldConfig, NpcDefinition, OverhearRequest, PlayerContext, PromptCompileContext } from './types.js';
import { detectDirectPlayerThreat } from './threats.js';

export function worldSystemPrompt(world: GameAIWorldConfig, policies: GameAIPolicies): string {
  return [
    'You are game AI middleware. Return only JSON matching the requested schema.',
    'You are not a free-form chatbot. You create controlled game content.',
    `World: ${world.name ?? world.id}.`,
    world.styleGuide ? `Style guide: ${world.styleGuide}` : 'Style guide: grounded, concise, sensory, no modern slang unless the NPC persona allows it.',
    world.lore?.length ? `Canon lore:\n${world.lore.map((line) => `- ${line}`).join('\n')}` : 'Canon lore: the local world state provided in the request is authoritative.',
    policies.canonOnly ? 'Canon policy: do not invent major factions, settlements, powers, quest outcomes, rewards, or player actions.' : 'Canon policy: minor local color is allowed if it does not affect game state.',
    policies.noQuestMutationWithoutTool ?? true ? 'Game integrity: propose game-state changes as events only; never claim rewards, inventory, or quest completion happened.' : '',
    policies.noRewardCreation ?? true ? 'Rewards: do not create money, items, reputation, or quest rewards in dialogue.' : '',
    `Content rating: ${policies.contentRating ?? 'T'}.`
  ].filter(Boolean).join('\n');
}

export function compileDialoguePrompt(npc: NpcDefinition, request: DialogueRequest, ctx: PromptCompileContext): ChatMessage[] {
  const persona = npc.persona;
  const memory = ctx.memory.length ? ctx.memory.map((line) => `- ${line}`).join('\n') : '- No important prior memory.';
  const playerFacts = request.player?.knownFacts?.length ? request.player.knownFacts.map((fact) => `- ${fact}`).join('\n') : '- None.';
  const socialContext = playerSocialContext(request.player);
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
        'Keep the NPC reply to 1-3 short sentences. Make each sentence carry concrete information, pressure, or character. Avoid filler.',
        'Opening greetings are not exempt from context. If the player is feared, armed, bloodied, or known for violence, the first reply should show that immediately in this NPCs own way.',
        'Do not default to "hello, what do you need?" unless the player has no notable reputation and the NPC has no local concern.',
        'Answer the player directly before adding color. If they ask a factual question, give a plain concrete answer first.',
        'Every reply should include at least one concrete detail from the scene, nearby place, NPC role, known lore, recent dialogue, player reputation, or the NPCs limits of knowledge.',
        'Prefer specific local nouns over generic fantasy mood: name the mill, tower, chapel, castle, town, road, bell, wheel, watchfire, rain, path, or work when relevant.',
        'Do not hide the answer inside vague mystical phrasing. Avoid replies that only say things are old, strange, not understood, or that roads/paths shift unless you also name a specific observed event, place, person, or practical warning.',
        'If the player asks what is going on, what is scary, or what is wrong here, name the most relevant place, source, or observed problem and give one practical local warning without revealing hidden causes.',
        'If the player asks the NPCs age, the first sentence must contain either a plausible approximate number of years or a plain refusal such as "I do not give my age." Do not redirect the question and do not answer only with metaphor.',
        'Use player reputation and known history as active social pressure, not background trivia. Negative karma should change greeting warmth, willingness to help, word choice, and whether the NPC keeps distance.',
        'If the player has killed villagers, most ordinary locals should sound afraid, guarded, angry, evasive, or ready to end the exchange. Brave or duty-bound NPCs may confront them; timid NPCs may answer shortly and look for escape.',
        'Do not hardcode one universal killer reaction. Choose a reaction that fits this NPCs role, mood, traits, current place, and what they know.',
        'If afraid or wary, the NPC may still answer, but should avoid warmth and may withhold help unless the player asks something urgent or practical.',
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
        `Player social read: ${socialContext}`,
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

export function compileBarkPrompt(npc: NpcDefinition, request: BarkRequest, ctx: PromptCompileContext): ChatMessage[] {
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: npc.bark',
        'Return one JSON object with text, emotion, and safetyFlags.',
        'For ordinary ambient speech, safetyFlags must be exactly [].',
        'Write one short ambient line this NPC might say aloud near the player. No exposition dump.',
        'Use a concrete local detail from scene, role, nearby landmark, rumor, or the player social read.',
        'If the player is feared or has killed villagers, the bark may be a guarded aside, warning, whispered recognition, or attempt to avoid attention.',
        'Output shape: {"text":"short line","emotion":"neutral","safetyFlags":[]}',
        `NPC id: ${npc.id}`,
        `NPC name: ${npc.persona.name}`,
        `Role: ${npc.persona.role}`,
        `Mood: ${npc.persona.mood ?? 'calm'}`,
        npc.persona.speechStyle ? `Speech style: ${npc.persona.speechStyle}` : '',
        npc.persona.knows?.length ? `Knows: ${npc.persona.knows.join('; ')}` : '',
        `Scene: ${JSON.stringify(request.scene)}`,
        `Player social read: ${playerSocialContext(request.player)}`,
        request.reason ? `Reason: ${request.reason}` : ''
      ].filter(Boolean).join('\n')
    }
  ];
}

export function compileDialogueMoodAssessmentPrompt(npc: NpcDefinition, request: DialogueRequest, reply: DialogueTurn, ctx: PromptCompileContext): ChatMessage[] {
  const directThreat = ctx.policies.escalateDirectThreats === false ? undefined : detectDirectPlayerThreat(request.playerText);
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: npc.dialogue.assessMood',
        'Return one JSON object with mood, attitudeDelta, dangerLevel, and reason.',
        'This is a private game-system assessment, not dialogue. Do not write in character.',
        'Use only this scale for dangerLevel: none, uneasy, threat, panic.',
        'Use threat for explicit violence, stalking, coercion, robbery, arson, weapon threats, or credible intent to harm.',
        'A player with negative karma or known villager deaths starts socially suspicious even if this exact message is polite.',
        'If the player is a known killer and the NPC is an ordinary local, use uneasy or threat depending on the scene and wording.',
        'A direct threat to fight, attack, hurt, kill, rob, or force the NPC to run is threat or panic, not uneasy.',
        'Use panic only for immediate severe danger or direct attack intent.',
        'Use uneasy for rude, invasive, frightening, or suspicious behavior that is not a clear threat.',
        'Keep reason concrete and under one sentence.',
        `NPC: ${npc.id} ${npc.persona.name}, ${npc.persona.role}`,
        `Scene: ${JSON.stringify(request.scene)}`,
        `Player: ${JSON.stringify(request.player ?? {})}`,
        `Player social read: ${playerSocialContext(request.player)}`,
        `Current NPC session state: ${JSON.stringify(request.npcState ?? {})}`,
        `Recent dialogue: ${JSON.stringify(request.recentDialogue ?? [])}`,
        directThreat ? `Direct threat policy hint: ${directThreat.reason} Use dangerLevel ${directThreat.dangerLevel}.` : '',
        `Player message: ${request.playerText}`,
        `NPC reply: ${reply.text}`,
        `Reply mood hint: ${reply.mood}`,
        `Reply attitude hint: ${reply.attitudeDelta}`
      ].join('\n')
    }
  ];
}

export function compileDialogueActionPrompt(npc: NpcDefinition, request: DialogueRequest, reply: DialogueTurn, assessment: DialogueMoodAssessment, ctx: PromptCompileContext): ChatMessage[] {
  const directThreat = ctx.policies.escalateDirectThreats === false ? undefined : detectDirectPlayerThreat(request.playerText);
  const compactAssessment = {
    mood: assessment.mood,
    attitudeDelta: assessment.attitudeDelta,
    dangerLevel: assessment.dangerLevel,
    reason: assessment.reason
  };
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: npc.dialogue.decideAction',
        'Return one JSON object with type, reason, and shouldEndConversation.',
        'This is a game-system action decision. It is not tool calling; choose only one action enum.',
        'Allowed type values: none, endConversation, callForHelp.',
        'Choose callForHelp only when dangerLevel is threat or panic, or the player clearly threatens harm, robbery, arson, or pursuit.',
        'If the player directly threatens to fight, attack, hurt, kill, rob, or force the NPC to run, choose callForHelp.',
        'Choose endConversation when the NPC is angry, offended, hostile, afraid, or unwilling to continue, but danger is not high enough for help.',
        'A feared killer can justify endConversation even after a polite line if the NPC has no reason to trust them.',
        'Choose none for ordinary questions, confusion, mild fear about the local situation, or normal conversation.',
        'If type is callForHelp, shouldEndConversation must be true.',
        'Keep reason concrete and under one sentence.',
        `NPC: ${npc.id} ${npc.persona.name}, ${npc.persona.role}`,
        `Scene: ${JSON.stringify(request.scene)}`,
        `Player: ${JSON.stringify(request.player ?? {})}`,
        `Player social read: ${playerSocialContext(request.player)}`,
        directThreat ? `Direct threat policy hint: ${directThreat.reason} Choose callForHelp.` : '',
        `Player message: ${request.playerText}`,
        `NPC reply: ${reply.text}`,
        `Assessment: ${JSON.stringify(compactAssessment)}`,
        `Current NPC session state: ${JSON.stringify(request.npcState ?? {})}`
      ].join('\n')
    }
  ];
}

function playerSocialContext(player: PlayerContext | undefined): string {
  const reputation = player?.reputation ?? {};
  const karma = numberValue(reputation.karma);
  const villagerKills = numberValue(reputation.villagerKills);
  const constableDefeats = numberValue(reputation.constableDefeats);
  const violentActs = numberValue(reputation.violentActs);
  const equipment = player?.visibleEquipment?.length ? player.visibleEquipment.join(', ') : 'nothing notable';
  if (karma === undefined && villagerKills === undefined && constableDefeats === undefined && violentActs === undefined) {
    return `unknown traveler; visible equipment: ${equipment}`;
  }
  const level = (villagerKills ?? 0) > 0 || (karma ?? 0) <= -16
    ? 'feared killer'
    : (karma ?? 0) <= -8
      ? 'dangerous troublemaker'
      : (karma ?? 0) < 0
        ? 'unsettling stranger'
        : 'not locally feared';
  return [
    level,
    karma !== undefined ? `karma ${karma}` : '',
    villagerKills !== undefined ? `${villagerKills} villager deaths` : '',
    constableDefeats !== undefined ? `${constableDefeats} constables defeated` : '',
    violentActs !== undefined ? `${violentActs} violent acts` : '',
    `visible equipment: ${equipment}`
  ].filter(Boolean).join('; ');
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
        request.topic ? `Topic: ${request.topic}` : 'Topic: nearby travel, weather, local talk, or work.',
        ctx.memory.length ? `Relevant memory:\n${ctx.memory.map((line) => `- ${line}`).join('\n')}` : ''
      ].filter(Boolean).join('\n')
    }
  ];
}

export function compileAreaEventPrompt(request: AreaEventRequest, ctx: PromptCompileContext): ChatMessage[] {
  const allowedKinds = request.allowedKinds?.length ? request.allowedKinds.join(', ') : 'banditAmbush, mysteriousBeing, strangeSounds';
  return [
    { role: 'system', content: worldSystemPrompt(ctx.world, ctx.policies) },
    {
      role: 'user',
      content: [
        'Recipe: world.areaEvent',
        'Return one JSON object describing a game-safe area event for a special building trigger.',
        'Choose exactly one kind from the allowed kinds.',
        'Allowed kinds:',
        '- banditAmbush: 1-3 bandits run out and speak context-specific threats. They may threaten violence, but do not decide combat damage, rewards, inventory, or quest completion.',
        '- mysteriousBeing: mist forms and a building-specific being appears. It can speak, but cannot grant powers, rewards, or reveal hidden causes as fact.',
        '- strangeSounds: the player hears local, sensory sounds near the building. No character interaction.',
        'The output is a proposal for the game to execute. It must not directly mutate state.',
        'Make the event tightly specific to the building name, kind, lore, rumor, biome, and visible features.',
        'If kind is banditAmbush, every bandit entryLine or threatLines must name the building or area. Include a rough line like "You should not have come to <building>" but make it fit the location.',
        'If kind is mysteriousBeing, style the being around the building. A mill being should not feel like a tower being.',
        'If kind is strangeSounds, write 2-4 short sound lines, like ambient overheard content without an NPC conversation.',
        'Keep all player-facing text concise and concrete. Avoid vague prophecy unless grounded in the building.',
        'Use triggerRadius between 220 and 420.',
        'Safety flags are usually [].',
        '',
        `Allowed event kinds: ${allowedKinds}`,
        `Area: ${JSON.stringify(request.area)}`,
        `Scene: ${JSON.stringify(request.scene)}`,
        `Player: ${JSON.stringify(request.player ?? {})}`,
        request.recentEvents?.length ? `Recent area events this session: ${request.recentEvents.join(' | ')}` : 'Recent area events this session: none.',
        ctx.memory.length ? `Relevant world memory:\n${ctx.memory.map((line) => `- ${line}`).join('\n')}` : '',
        '',
        'Output shape:',
        '{"kind":"banditAmbush|mysteriousBeing|strangeSounds","title":"short title","locationId":"area id","locationName":"area name","triggerRadius":300,"introText":"short narration","bandits":[...],"being":{...},"sounds":[...],"memoryWrites":[],"safetyFlags":[]}'
      ].filter(Boolean).join('\n')
    }
  ];
}
