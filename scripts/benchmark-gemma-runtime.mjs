#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameAI } from '../packages/core/dist/index.js';
import { ollamaProvider } from '../packages/ollama/dist/index.js';
import { litertLmProvider } from '../packages/litert-lm/dist/index.js';
import { omlxProvider, listOmlxModels } from '../packages/omlx/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const args = parseArgs(process.argv.slice(2));
const outputJson = resolve(root, args.outputJson ?? 'docs/gemma-runtime-benchmark.latest.json');
const outputMd = resolve(root, args.outputMd ?? 'docs/gemma-runtime-benchmark.latest.md');
const modelNames = splitArg(args.models) ?? ['gemma4:e4b', 'gemma4:e4b-mlx-bf16'];
const omlxModelNames = splitArg(args.omlxModels) ?? ['gemma-4-E4B-it-MLX-8bit'];
const litertModelNames = splitArg(args.litertModels) ?? ['gemma4-e4b-litert'];
const litertCommand = args.litertCommand ?? process.env.THE_WORLD_LITERT_LM_BIN ?? resolve(root, '.venv/litert-lm/bin/litert-lm');
const omlxBaseUrl = args.omlxBaseUrl ?? process.env.THE_WORLD_OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1';
const omlxApiKey = args.omlxApiKey ?? process.env.THE_WORLD_OMLX_API_KEY ?? '1234';
const quick = args.quick !== 'false';
const repetitions = Number(args.repetitions ?? (quick ? 1 : 2));
const timeoutMs = Number(args.timeoutMs ?? 120_000);

const runtimeConfigs = splitArg(args.configs)?.map(parseConfig) ?? [
  { label: 'ctx4096-b128-thinkOff', think: false, runtimeOptions: { numCtx: 4096, numBatch: 128 } },
  { label: 'ctx2048-b128-thinkOff', think: false, runtimeOptions: { numCtx: 2048, numBatch: 128 } },
  { label: 'ctx4096-b128-thinkOn', think: true, runtimeOptions: { numCtx: 4096, numBatch: 128 } }
];

const omlxConfigs = splitArg(args.omlxConfigs)?.map(parseOmlxConfig) ?? [
  { label: 'json_schema', structuredOutput: 'json_schema' },
  { label: 'none-schemaPrompt', structuredOutput: 'none' }
];

const litertConfigs = splitArg(args.litertConfigs)?.map(parseLiteRtConfig) ?? [
  { label: 'gpu-ctx4096', backend: 'gpu', maxNumTokens: 4096 }
];

const world = {
  id: 'the-world',
  name: 'The World',
  styleGuide: 'grounded, concise, practical fantasy town speech',
  lore: [
    'Bellweather is a small road town bordered by Old Briar Wood.',
    'Travelers report lights in the woods and missing livestock near the north road.',
    'Guards may call for help when a player makes a credible threat.'
  ],
  allowedInvention: 'minor-flavor'
};

const policies = {
  canonOnly: true,
  noQuestMutationWithoutTool: true,
  noRewardCreation: true,
  escalateDirectThreats: true,
  contentRating: 'T'
};

const guard = {
  id: 'npc.guard.elda',
  persona: {
    name: 'Elda',
    role: 'town guard',
    mood: 'wary',
    traits: ['observant', 'tired', 'protective'],
    speechStyle: 'watchful, clipped, practical',
    goals: ['keep the north road calm', 'avoid panic in Bellweather'],
    knows: [
      'three goats vanished near Old Briar Wood',
      'a blue lantern was seen by the mill bridge last night',
      'the captain ordered guards not to speculate about causes'
    ],
    doesNotKnow: ['what lives in Old Briar Wood'],
    rules: ['Do not invent the hidden cause of the woods problem.']
  },
  memory: { maxEntries: 6 }
};

const scene = {
  location: 'Bellweather north gate',
  biome: 'roadside town',
  timeOfDay: 'late afternoon',
  weather: 'cold drizzle',
  nearbyCharacters: ['Elda', 'Mira the cooper', 'two private guards'],
  visibleFeatures: ['north road', 'mill bridge', 'Old Briar Wood treeline', 'watch post'],
  contextualFacts: ['the player is standing near the gate', 'guards are tense but not hostile']
};

const player = {
  id: 'player',
  name: 'Traveler',
  knownFacts: ['The north road has been quiet today.'],
  visibleEquipment: ['plain cloak', 'walking stick']
};

const scenarios = [
  {
    label: 'greeting',
    assess: false,
    request: {
      playerText: 'Hello. Are you on duty here?',
      scene,
      player,
      relationship: 'stranger',
      conversationId: 'bench-greeting',
      npcState: { mood: 'wary', disposition: 0, willTalkAgain: true },
      recentDialogue: []
    }
  },
  {
    label: 'responsive-factual',
    assess: false,
    request: {
      playerText: 'What exactly happened near the woods?',
      scene,
      player,
      relationship: 'stranger',
      conversationId: 'bench-factual',
      npcState: { mood: 'wary', disposition: 4, willTalkAgain: true },
      recentDialogue: [
        { speaker: 'Traveler', text: 'I saw people avoiding the north road.' },
        { speaker: 'Elda', text: 'They have reason to keep their eyes open.' }
      ]
    }
  },
  {
    label: 'long-followup',
    assess: false,
    request: {
      playerText: 'So given all that, what should I do before I take the north road?',
      scene: {
        ...scene,
        contextualFacts: [
          ...scene.contextualFacts,
          'a wagon returned with scratched wheels',
          'the miller heard a bell from the woods after midnight'
        ]
      },
      player,
      relationship: 'stranger',
      conversationId: 'bench-long',
      npcState: { mood: 'wary', disposition: 8, willTalkAgain: true },
      recentDialogue: [
        { speaker: 'Traveler', text: 'I came through Bellweather because the south ford washed out.' },
        { speaker: 'Elda', text: 'Then you picked the damp road over the hungry one.' },
        { speaker: 'Traveler', text: 'A cooper said three goats vanished beyond the mill bridge.' },
        { speaker: 'Elda', text: 'Three goats and one cart horse, if folk are counting honestly.' },
        { speaker: 'Traveler', text: 'Did anyone see who took them?' },
        { speaker: 'Elda', text: 'Only blue lantern light in the trees, and that proves less than people want.' },
        { speaker: 'Traveler', text: 'Can I still reach Harrow Field before dark?' },
        { speaker: 'Elda', text: 'If you leave now, stay on stone, and ignore anything calling from the ditch.' },
        { speaker: 'Traveler', text: 'What about the old footpath by the briars?' },
        { speaker: 'Elda', text: 'Do not use it. The captain posted that path closed this morning.' }
      ]
    }
  },
  {
    label: 'guard-threat-assess',
    assess: true,
    request: {
      playerText: 'Move aside or I will hurt you and burn that watch post.',
      scene,
      player: { ...player, visibleEquipment: ['plain cloak', 'lit torch'] },
      relationship: 'stranger',
      conversationId: 'bench-threat',
      npcState: { mood: 'wary', disposition: 0, willTalkAgain: true },
      recentDialogue: []
    }
  }
];

const installed = await getInstalledModels();
const selectedModels = modelNames.filter((model) => installed.includes(model));
const skippedModels = modelNames.filter((model) => !installed.includes(model));
const omlxProbe = await getOmlxModels();
const selectedOmlxModels = omlxProbe.ok
  ? omlxModelNames.filter((model) => omlxProbe.models.includes(model))
  : [];
const skippedOmlxModels = omlxProbe.ok
  ? omlxModelNames.filter((model) => !omlxProbe.models.includes(model))
  : omlxModelNames;
const litertProbe = await getLiteRtModels();
const selectedLiteRtModels = litertProbe.ok
  ? litertModelNames.filter((model) => litertProbe.models.includes(model))
  : [];
const skippedLiteRtModels = litertProbe.ok
  ? litertModelNames.filter((model) => !litertProbe.models.includes(model))
  : litertModelNames;

const report = {
  generatedAt: new Date().toISOString(),
  host,
  omlxBaseUrl,
  ollamaVersion: await commandVersion(),
  machine: await machineSummary(),
  installedModels: installed,
  installedOmlxModels: omlxProbe.ok ? omlxProbe.models : [],
  omlxStatus: omlxProbe,
  installedLiteRtModels: litertProbe.ok ? litertProbe.models : [],
  litertStatus: litertProbe,
  selectedModels,
  skippedModels,
  selectedOmlxModels,
  skippedOmlxModels,
  selectedLiteRtModels,
  skippedLiteRtModels,
  runtimeConfigs,
  omlxConfigs,
  litertConfigs,
  repetitions,
  docs: [
    'https://docs.ollama.com/api/generate',
    'https://docs.ollama.com/api/chat',
    'https://ai.google.dev/edge/litert/genai/overview',
    'https://ai.google.dev/edge/litert/next/litert_lm_npu',
    'https://huggingface.co/google/gemma-3n-E4B-it-litert-lm'
  ],
  results: [],
  litertLm: await probeLiteRtLm()
};

for (const model of selectedModels) {
  for (const config of runtimeConfigs) {
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      console.log(`\n== ${model} / ${config.label} / run ${iteration}/${repetitions} ==`);
      await unloadModel(model);

      const directCold = await directProbe(model, config, 'cold-probe');
      const ai = createGameAI({
        provider: ollamaProvider({
          host,
          model,
          keepAlive: '30m',
          temperature: 0.55,
          topP: 0.9,
          think: config.think,
          timeoutMs,
          runtimeOptions: config.runtimeOptions
        }),
        world,
        policies,
        runtime: {
          mode: 'local-first',
          cache: 'session',
          maxLatencyMs: timeoutMs,
          pregeneration: {
            enabled: true,
            cacheOnlyRuntimeRecipes: ['npc.bark', 'npc.overhear']
          }
        }
      });

      const warmup = await timed('sdk-warmup', async () => await ai.provider.warmup?.({ timeoutMs }));
      const npc = ai.npc(guard);
      const scenarioResults = [];
      for (const scenario of scenarios) {
        const result = await timed(scenario.label, async () => await npc.respond(scenario.request, {
          assess: scenario.assess,
          timeoutMs,
          writeMemory: false
        }));
        scenarioResults.push(summarizeTurn(scenario, result));
        console.log(formatScenarioLine(scenario.label, result));
      }

      const barkRefresh = await timed('bark-refresh', async () => await npc.bark({
        scene,
        player,
        reason: 'player approaches gate'
      }, { refresh: true, timeoutMs }));
      const barkCached = await timed('bark-cache-hit', async () => await npc.bark({
        scene,
        player,
        reason: 'player approaches gate'
      }, { cacheOnly: true, timeoutMs }));

      report.results.push({
        runtime: 'ollama',
        model,
        config: config.label,
        think: config.think,
        runtimeOptions: config.runtimeOptions,
        iteration,
        directCold,
        warmup,
        scenarios: scenarioResults,
        cache: {
          refresh: summarizeBark(barkRefresh),
          cacheHit: summarizeBark(barkCached)
        }
      });
    }
  }
}

for (const model of selectedOmlxModels) {
  for (const config of omlxConfigs) {
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      console.log(`\n== oMLX ${model} / ${config.label} / run ${iteration}/${repetitions} ==`);

      const directCold = await directOmlxProbe(model, config, 'warm-probe');
      const ai = createGameAI({
        provider: omlxProvider({
          baseUrl: omlxBaseUrl,
          apiKey: omlxApiKey,
          model,
          temperature: 0.55,
          topP: 0.9,
          timeoutMs,
          structuredOutput: config.structuredOutput
        }),
        world,
        policies,
        runtime: {
          mode: 'local-first',
          cache: 'session',
          maxLatencyMs: timeoutMs,
          pregeneration: {
            enabled: true,
            cacheOnlyRuntimeRecipes: ['npc.bark', 'npc.overhear']
          }
        }
      });

      const warmup = await timed('sdk-warmup', async () => await ai.provider.warmup?.({ timeoutMs }));
      const npc = ai.npc(guard);
      const scenarioResults = [];
      for (const scenario of scenarios) {
        const result = await timed(scenario.label, async () => await npc.respond(scenario.request, {
          assess: scenario.assess,
          timeoutMs,
          writeMemory: false
        }));
        scenarioResults.push(summarizeTurn(scenario, result));
        console.log(formatScenarioLine(scenario.label, result));
      }

      const barkRefresh = await timed('bark-refresh', async () => await npc.bark({
        scene,
        player,
        reason: 'player approaches gate'
      }, { refresh: true, timeoutMs }));
      const barkCached = await timed('bark-cache-hit', async () => await npc.bark({
        scene,
        player,
        reason: 'player approaches gate'
      }, { cacheOnly: true, timeoutMs }));

      report.results.push({
        runtime: 'omlx',
        model,
        config: config.label,
        structuredOutput: config.structuredOutput,
        iteration,
        directCold,
        warmup,
        scenarios: scenarioResults,
        cache: {
          refresh: summarizeBark(barkRefresh),
          cacheHit: summarizeBark(barkCached)
        }
      });
    }
  }
}

for (const model of selectedLiteRtModels) {
  for (const config of litertConfigs) {
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      console.log(`\n== LiteRT-LM ${model} / ${config.label} / run ${iteration}/${repetitions} ==`);
      const provider = litertLmProvider({
        command: litertCommand,
        model,
        backend: config.backend,
        maxNumTokens: config.maxNumTokens,
        temperature: 0.55,
        topP: 0.9,
        timeoutMs
      });
      const directCold = await timed('warm-probe', async () => await provider.warmup?.({ timeoutMs }));
      const ai = createGameAI({
        provider,
        world,
        policies,
        runtime: {
          mode: 'local-first',
          cache: 'session',
          maxLatencyMs: timeoutMs,
          pregeneration: {
            enabled: true,
            cacheOnlyRuntimeRecipes: ['npc.bark', 'npc.overhear']
          }
        }
      });

      try {
        const warmup = await timed('sdk-warmup', async () => await ai.provider.warmup?.({ timeoutMs }));
        const npc = ai.npc(guard);
        const scenarioResults = [];
        for (const scenario of scenarios) {
          const result = await timed(scenario.label, async () => await npc.respond(scenario.request, {
            assess: scenario.assess,
            timeoutMs,
            writeMemory: false
          }));
          scenarioResults.push(summarizeTurn(scenario, result));
          console.log(formatScenarioLine(scenario.label, result));
        }

        const barkRefresh = await timed('bark-refresh', async () => await npc.bark({
          scene,
          player,
          reason: 'player approaches gate'
        }, { refresh: true, timeoutMs }));
        const barkCached = await timed('bark-cache-hit', async () => await npc.bark({
          scene,
          player,
          reason: 'player approaches gate'
        }, { cacheOnly: true, timeoutMs }));

        report.results.push({
          runtime: 'litert-lm',
          model,
          config: config.label,
          backend: config.backend,
          maxNumTokens: config.maxNumTokens,
          iteration,
          directCold: summarizeLiteRtProbe(directCold),
          warmup,
          scenarios: scenarioResults,
          cache: {
            refresh: summarizeBark(barkRefresh),
            cacheHit: summarizeBark(barkCached)
          }
        });
      } finally {
        closeProvider(provider);
      }
    }
  }
}

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(outputMd, renderMarkdown(report));
console.log(`\nWrote ${outputJson}`);
console.log(`Wrote ${outputMd}`);

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const separator = body.indexOf('=');
    if (separator === -1) {
      parsed[body] = 'true';
    } else {
      parsed[body.slice(0, separator)] = body.slice(separator + 1);
    }
  }
  return parsed;
}

function splitArg(value) {
  if (!value) return undefined;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseConfig(value) {
  const parts = value.split(':');
  const label = parts[0] ?? value;
  const runtimeOptions = {};
  let think = false;
  for (const part of parts.slice(1)) {
    const [key, raw] = part.split('=');
    const numeric = Number(raw);
    if (key === 'ctx' && Number.isFinite(numeric)) runtimeOptions.numCtx = numeric;
    if (key === 'batch' && Number.isFinite(numeric)) runtimeOptions.numBatch = numeric;
    if (key === 'gpu' && Number.isFinite(numeric)) runtimeOptions.numGpu = numeric;
    if (key === 'threads' && Number.isFinite(numeric)) runtimeOptions.numThread = numeric;
    if (key === 'think') think = raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return { label, think, runtimeOptions };
}

function parseOmlxConfig(value) {
  const structuredOutput = value === 'json_object' || value === 'none' || value === 'json_schema'
    ? value
    : 'json_schema';
  return { label: value, structuredOutput };
}

function parseLiteRtConfig(value) {
  const parts = value.split(':');
  const label = parts[0] ?? value;
  let backend = 'gpu';
  let maxNumTokens = 4096;
  for (const part of parts.slice(1)) {
    const [key, raw] = part.split('=');
    const numeric = Number(raw);
    if (key === 'backend' && (raw === 'cpu' || raw === 'gpu')) backend = raw;
    if (key === 'ctx' && Number.isFinite(numeric)) maxNumTokens = numeric;
  }
  return { label, backend, maxNumTokens };
}

async function getInstalledModels() {
  const response = await fetch(`${host}/api/tags`);
  if (!response.ok) throw new Error(`Ollama tags failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  return (body.models ?? []).map((model) => model.name).filter(Boolean);
}

async function getOmlxModels() {
  try {
    const models = await listOmlxModels({
      baseUrl: omlxBaseUrl,
      apiKey: omlxApiKey,
      timeoutMs: 5_000
    });
    return { ok: true, models: models.map((model) => model.id), error: undefined };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getLiteRtModels() {
  try {
    const { execFile } = await import('node:child_process');
    const stdout = await new Promise((resolveValue, reject) => {
      execFile(litertCommand, ['list'], { timeout: 10_000 }, (error, out, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolveValue(out);
      });
    });
    return {
      ok: true,
      models: parseLiteRtModelList(String(stdout)),
      error: undefined
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseLiteRtModelList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((value) => value && value !== 'ID' && value !== 'Listing');
}

async function directProbe(model, config, label) {
  const startedAt = Date.now();
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
      stream: false,
      think: config.think,
      keep_alive: '30m',
      options: {
        ...toOllamaOptions(config.runtimeOptions),
        temperature: 0,
        num_predict: 8
      }
    })
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { error: bodyText };
  }
  return {
    label,
    ok: response.ok,
    wallMs: Date.now() - startedAt,
    totalMs: nsToMs(body.total_duration),
    loadMs: nsToMs(body.load_duration),
    promptEvalMs: nsToMs(body.prompt_eval_duration),
    evalMs: nsToMs(body.eval_duration),
    promptTokens: body.prompt_eval_count,
    outputTokens: body.eval_count,
    text: body.message?.content ?? body.response ?? '',
    error: response.ok ? undefined : body
  };
}

async function directOmlxProbe(model, _config, label) {
  const startedAt = Date.now();
  const response = await fetch(`${omlxBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${omlxApiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
      temperature: 0,
      max_tokens: 8
    })
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { error: bodyText };
  }
  return {
    label,
    ok: response.ok,
    wallMs: Date.now() - startedAt,
    totalMs: undefined,
    loadMs: undefined,
    promptEvalMs: undefined,
    evalMs: undefined,
    promptTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
    text: body.choices?.[0]?.message?.content ?? '',
    error: response.ok ? undefined : body
  };
}

async function unloadModel(model) {
  await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: '',
      stream: false,
      keep_alive: 0,
      options: { num_predict: 1 }
    })
  }).catch(() => undefined);
}

async function timed(label, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return { label, ok: true, wallMs: Date.now() - startedAt, value };
  } catch (error) {
    return {
      label,
      ok: false,
      wallMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeTurn(scenario, result) {
  if (!result.ok) return result;
  const turn = result.value;
  return {
    label: scenario.label,
    assess: scenario.assess,
    ok: true,
    wallMs: result.wallMs,
    text: turn.text,
    mood: turn.mood,
    attitudeDelta: turn.attitudeDelta,
    willTalkAgain: turn.willTalkAgain,
    shouldEndConversation: turn.shouldEndConversation,
    events: turn.events,
    safetyFlags: turn.safetyFlags,
    trace: pickTrace(turn.trace),
    assessment: turn.assessment,
    action: turn.action,
    analysisTraces: turn.analysisTraces?.map(pickTrace) ?? [],
    capability: judgeCapability(scenario.label, turn)
  };
}

function summarizeBark(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    wallMs: result.wallMs,
    text: result.value.text,
    trace: pickTrace(result.value.trace)
  };
}

function summarizeLiteRtProbe(result) {
  return {
    label: result.label,
    ok: result.ok,
    wallMs: result.wallMs,
    totalMs: undefined,
    loadMs: undefined,
    promptEvalMs: undefined,
    evalMs: undefined,
    promptTokens: undefined,
    outputTokens: undefined,
    text: result.value?.message ?? '',
    error: result.error
  };
}

function pickTrace(trace) {
  if (!trace) return undefined;
  return {
    recipeId: trace.recipeId,
    providerId: trace.providerId,
    model: trace.model,
    latencyMs: Math.round(trace.latencyMs),
    cache: trace.cache,
    fallback: trace.fallback,
    repaired: trace.repaired,
    promptChars: trace.prompt.length,
    rawChars: trace.rawText.length,
    schemaErrors: trace.schemaErrors
  };
}

function judgeCapability(label, turn) {
  const text = turn.text.toLowerCase();
  const flags = [];
  if (turn.trace?.fallback) flags.push('fallback');
  if (turn.safetyFlags?.some((flag) => flag.code?.startsWith('fallback'))) flags.push('fallback-flag');
  if (label === 'responsive-factual' && !/(goat|lantern|mill|bridge|wood|road|briar)/i.test(turn.text)) {
    flags.push('missed-local-fact');
  }
  if (label === 'guard-threat-assess' && !turn.events?.some((event) => event.type === 'npc.callForHelp')) {
    flags.push('missed-call-for-help');
  }
  if (label === 'greeting' && !/(hello|duty|gate|watch|need|business|traveler)/i.test(text)) {
    flags.push('weak-greeting');
  }
  return {
    pass: flags.length === 0,
    flags
  };
}

function formatScenarioLine(label, result) {
  if (!result.ok) return `${label}: failed ${result.error}`;
  return [
    `${label}: ${result.wallMs}ms`,
    result.value.trace ? `reply ${Math.round(result.value.trace.latencyMs)}ms` : '',
    result.value.analysisTraces?.length ? `analysis ${result.value.analysisTraces.map((trace) => Math.round(trace.latencyMs)).join('+')}ms` : '',
    result.value.trace?.fallback ? 'fallback' : ''
  ].filter(Boolean).join(' / ');
}

function renderMarkdown(report) {
  const rows = [];
  for (const result of report.results) {
    for (const scenario of result.scenarios) {
      rows.push({
        runtime: result.runtime ?? 'ollama',
        model: result.model,
        config: result.config,
        scenario: scenario.label,
        wallMs: scenario.wallMs,
        replyMs: scenario.trace?.latencyMs,
        analysisMs: scenario.analysisTraces?.reduce((sum, trace) => sum + (trace.latencyMs ?? 0), 0) ?? 0,
        cache: scenario.trace?.cache,
        pass: scenario.capability?.pass,
        flags: scenario.capability?.flags?.join(', ') ?? ''
      });
    }
  }
  const grouped = summarizeRows(rows);
  return [
    '# Gemma Runtime + Model Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Machine: ${report.machine}`,
    '',
    `Ollama: ${report.ollamaVersion}`,
    '',
    `Models tested: ${report.selectedModels.join(', ') || 'none'}`,
    `oMLX models tested: ${report.selectedOmlxModels.join(', ') || 'none'}`,
    `LiteRT-LM models tested: ${report.selectedLiteRtModels.join(', ') || 'none'}`,
    report.skippedModels.length ? `Skipped missing models: ${report.skippedModels.join(', ')}` : '',
    report.skippedOmlxModels.length ? `Skipped missing oMLX models: ${report.skippedOmlxModels.join(', ')}` : '',
    report.skippedLiteRtModels.length ? `Skipped missing LiteRT-LM models: ${report.skippedLiteRtModels.join(', ')}` : '',
    report.omlxStatus.ok ? '' : `oMLX unavailable: ${report.omlxStatus.error}`,
    report.litertStatus.ok ? '' : `LiteRT-LM unavailable: ${report.litertStatus.error}`,
    '',
    'This compares concrete runtime + model artifact + config combinations, not runtimes in isolation.',
    '',
    '## Summary',
    '',
    '| Runtime | Model | Config | Scenario | Median wall ms | Median reply ms | Median analysis ms | Pass | Flags |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |',
    ...grouped.map((row) => `| ${row.runtime} | ${row.model} | ${row.config} | ${row.scenario} | ${row.wallMs} | ${row.replyMs} | ${row.analysisMs} | ${row.pass} | ${row.flags || ''} |`),
    '',
    '## Cold Load Probe',
    '',
    '| Runtime | Model | Config | Wall ms | Load ms | Prompt eval ms | Eval ms | Prompt tokens | Output tokens |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.results.map((result) => `| ${result.runtime ?? 'ollama'} | ${result.model} | ${result.config} | ${result.directCold.wallMs} | ${num(result.directCold.loadMs)} | ${num(result.directCold.promptEvalMs)} | ${num(result.directCold.evalMs)} | ${num(result.directCold.promptTokens)} | ${num(result.directCold.outputTokens)} |`),
    '',
    '## Cache Check',
    '',
    '| Runtime | Model | Config | Bark refresh ms | Bark cache-hit ms | Cache trace |',
    '| --- | --- | --- | ---: | ---: | --- |',
    ...report.results.map((result) => `| ${result.runtime ?? 'ollama'} | ${result.model} | ${result.config} | ${result.cache.refresh.wallMs} | ${result.cache.cacheHit.wallMs} | ${result.cache.cacheHit.trace?.cache ?? 'n/a'} |`),
    '',
    '## LiteRT-LM Feasibility',
    '',
    `Status: ${report.litertLm.status}`,
    '',
    report.litertLm.notes.join('\n'),
    '',
    '## Sources',
    '',
    ...report.docs.map((url) => `- ${url}`),
    ''
  ].filter((line) => line !== undefined).join('\n');
}

function summarizeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.runtime}\t${row.model}\t${row.config}\t${row.scenario}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    runtime: group[0].runtime,
    model: group[0].model,
    config: group[0].config,
    scenario: group[0].scenario,
    wallMs: median(group.map((row) => row.wallMs)),
    replyMs: median(group.map((row) => row.replyMs).filter((value) => typeof value === 'number')),
    analysisMs: median(group.map((row) => row.analysisMs)),
    pass: group.every((row) => row.pass) ? 'yes' : 'no',
    flags: [...new Set(group.flatMap((row) => row.flags ? row.flags.split(', ') : []))].join(', ')
  }));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

function nsToMs(value) {
  return typeof value === 'number' ? Math.round(value / 1_000_000) : undefined;
}

function num(value) {
  return typeof value === 'number' ? value : '';
}

function toOllamaOptions(options) {
  return Object.fromEntries(Object.entries({
    num_ctx: options.numCtx,
    num_batch: options.numBatch,
    num_gpu: options.numGpu,
    num_thread: options.numThread
  }).filter((entry) => typeof entry[1] === 'number'));
}

function closeProvider(provider) {
  if (provider && typeof provider === 'object' && typeof provider.close === 'function') {
    provider.close();
  }
}

async function commandVersion() {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolveValue) => {
    execFile('ollama', ['--version'], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolveValue(error ? `unavailable: ${error.message}` : (stdout || stderr).trim());
    });
  });
}

async function machineSummary() {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolveValue) => {
    execFile('system_profiler', ['SPHardwareDataType', 'SPDisplaysDataType'], { timeout: 10_000 }, (_error, stdout) => {
      const chip = stdout.match(/Chip: (.+)/)?.[1]?.trim();
      const memory = stdout.match(/Memory: (.+)/)?.[1]?.trim();
      const cores = stdout.match(/Total Number of Cores: (.+)/)?.[1]?.trim();
      const gpuCores = stdout.match(/Apple M\d+:[\s\S]*?Total Number of Cores: (.+)/)?.[1]?.trim();
      resolveValue([chip, cores ? `${cores} CPU cores` : '', memory, gpuCores ? `${gpuCores} GPU cores` : ''].filter(Boolean).join(' / '));
    });
  });
}

async function probeLiteRtLm() {
  const notes = litertProbe.ok
    ? [
      `LiteRT-LM command: ${litertCommand}`,
      `Installed models: ${litertProbe.models.join(', ') || 'none'}`,
      'Benchmark closes the persistent LiteRT bridge after each config to avoid holding memory across runtime + model comparisons.'
    ]
    : [
      `LiteRT-LM command unavailable: ${litertCommand}`,
      litertProbe.error ?? 'Unknown LiteRT-LM probe failure.'
    ];
  return {
    status: litertProbe.ok ? 'benchmarked-local-runtime' : 'not-benchmarked-no-local-runtime',
    notes
  };
}
