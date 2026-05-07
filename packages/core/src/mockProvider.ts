import type { GameAIProvider, GenerateRequest, GenerateResult, ProviderHealth } from './types.js';

export class MockGameAIProvider implements GameAIProvider {
  readonly id = 'mock';
  readonly model = 'mock-deterministic';

  async health(): Promise<ProviderHealth> {
    return {
      ok: true,
      provider: this.id,
      model: this.model,
      mode: 'ready',
      message: 'Using deterministic mock game AI.'
    };
  }

  async warmup(): Promise<ProviderHealth> {
    return await this.health();
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = Date.now();
    const recipeId = String(request.metadata?.recipeId ?? '');
    const text = recipeId.includes('overhear')
      ? this.overhear(request)
      : recipeId.includes('bark')
        ? this.bark(request)
        : recipeId.includes('assessMood')
          ? this.assessMood(request)
          : recipeId.includes('decideAction')
            ? this.decideAction(request)
            : this.dialogue(request);

    return {
      text,
      model: this.model,
      metrics: {
        latencyMs: Date.now() - startedAt,
        outputTokens: Math.ceil(text.length / 4)
      }
    };
  }

  private dialogue(request: GenerateRequest): string {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const name = capture(prompt, /NPC name: (.+)/) ?? 'A traveler';
    const role = capture(prompt, /Role: (.+)/) ?? 'wanderer';
    const mood = capture(prompt, /Mood: (.+)/) ?? 'calm';
    const playerText = capture(prompt, /Player says: ([\s\S]+)/)?.split('\n')[0]?.trim() ?? '';
    const goodbye = /bye|goodbye|farewell|later|i should go/i.test(playerText);
    const insult = /stupid|idiot|shut up|hate you|useless|worthless|fool/i.test(playerText);
    const bump = /bumped into you|ran into you|collided/i.test(playerText);
    const question = playerText.endsWith('?') || /why|what|where|who|how/i.test(playerText);
    const emotion = insult || bump ? 'angry' : goodbye ? 'warm' : mood.includes('wary') ? 'suspicious' : question ? 'curious' : 'neutral';
    const nextMood = insult ? 'offended' : bump ? 'angry' : goodbye ? 'calm' : emotion === 'curious' ? 'curious' : mood.includes('wary') ? 'wary' : 'calm';
    const line = goodbye
      ? `"Safe roads. If the paths start whispering, do not answer first."`
      : insult
        ? `"Enough. Take that tongue somewhere else," ${name} says.`
        : bump
          ? `"Mind your boots," ${name} snaps.`
          : question
        ? `"I know enough to be careful," ${name} says. "The land changes, but tracks and debts always tell the truth."`
        : `"Around here, even a ${role} learns to listen before speaking."`;

    return JSON.stringify({
      text: line,
      emotion,
      mood: nextMood,
      attitudeDelta: insult ? -30 : bump ? -8 : goodbye ? 0 : question ? 2 : 0,
      willTalkAgain: !insult,
      ...(insult ? { refusalReason: 'The player was insulting.' } : {}),
      animationHint: goodbye ? 'wave' : question ? 'thinking' : 'idle',
      events: [
        { type: 'dialogue.say', npcId: String(request.metadata?.npcId ?? 'npc.unknown'), text: line },
        { type: 'npc.emotion', npcId: String(request.metadata?.npcId ?? 'npc.unknown'), emotion }
      ],
      memoryWrites: goodbye ? [] : [
        {
          scope: 'npc',
          id: String(request.metadata?.npcId ?? 'npc.unknown'),
          text: `The player said: ${playerText.slice(0, 120)}`,
          importance: question ? 0.55 : 0.35
        }
      ],
      safetyFlags: [],
      shouldEndConversation: goodbye || insult
    });
  }

  private bark(request: GenerateRequest): string {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const name = capture(prompt, /NPC name: (.+)/) ?? 'Someone';
    const options = [
      `${name} mutters, "These hills were not here yesterday."`,
      `${name} says, "Path bends north, then forgets why."`,
      `${name} hums a work tune and watches the trees.`
    ];
    const text = options[Math.abs(hash(prompt)) % options.length]!;
    return JSON.stringify({ text, emotion: 'neutral', safetyFlags: [] });
  }

  private assessMood(request: GenerateRequest): string {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const playerText = capture(prompt, /Player message: ([\s\S]*?)\nNPC reply:/)?.trim() ?? '';
    const threat = /kill|hurt|attack|rob|burn|weapon|stab|shoot|cut you|follow you home/i.test(playerText);
    const uneasy = /scary|afraid|watching|where do you live|alone|idiot|stupid/i.test(playerText);
    return JSON.stringify({
      mood: threat ? 'hostile' : uneasy ? 'wary' : 'calm',
      attitudeDelta: threat ? -25 : uneasy ? -6 : 0,
      dangerLevel: threat ? 'threat' : uneasy ? 'uneasy' : 'none',
      reason: threat ? 'The player made a credible threat.' : uneasy ? 'The player made the NPC wary.' : 'No danger in the exchange.'
    });
  }

  private decideAction(request: GenerateRequest): string {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const threat = /"dangerLevel":"threat"|"dangerLevel":"panic"|credible threat/i.test(prompt);
    const uneasy = /"dangerLevel":"uneasy"|"mood":"hostile"|"mood":"offended"|"mood":"angry"/i.test(prompt);
    return JSON.stringify({
      type: threat ? 'callForHelp' : uneasy ? 'endConversation' : 'none',
      reason: threat ? 'The player made a credible threat.' : uneasy ? 'The NPC no longer wants to continue.' : 'No action needed.',
      shouldEndConversation: threat || uneasy
    });
  }

  private overhear(request: GenerateRequest): string {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const npcA = capture(prompt, /NPC A: (\S+)/) ?? 'npc.a';
    const npcB = capture(prompt, /NPC B: (\S+)/) ?? 'npc.b';
    return JSON.stringify({
      lines: [
        { npcId: npcA, text: 'Saw smoke beyond the west hill again.', emotion: 'suspicious' },
        { npcId: npcB, text: 'Smoke is honest. People are the worry.', emotion: 'amused' }
      ],
      safetyFlags: []
    });
  }
}

function capture(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}
