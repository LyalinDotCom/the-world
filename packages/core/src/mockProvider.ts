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
    const question = playerText.endsWith('?') || /why|what|where|who|how/i.test(playerText);
    const emotion = goodbye ? 'warm' : mood.includes('wary') ? 'suspicious' : question ? 'curious' : 'neutral';
    const line = goodbye
      ? `"Safe roads. If the paths start whispering, do not answer first."`
      : question
        ? `"I know enough to be careful," ${name} says. "The land changes, but tracks and debts always tell the truth."`
        : `"Around here, even a ${role} learns to listen before speaking."`;

    return JSON.stringify({
      text: line,
      emotion,
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
      shouldEndConversation: goodbye
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
