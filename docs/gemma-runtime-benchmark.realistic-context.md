# Gemma Runtime Benchmark

Generated: 2026-05-10T15:56:44.741Z

Machine: Apple M5 / 10 (4 Super and 6 Efficiency) CPU cores / 32 GB / 10 GPU cores

Ollama: ollama version is 0.23.2

Models tested: gemma4:e4b


## Summary

| Model | Config | Scenario | Median wall ms | Median reply ms | Median analysis ms | Pass | Flags |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| gemma4:e4b | ctx2048-b128-thinkOff | greeting | 7290 | 7287 | 0 | yes |  |
| gemma4:e4b | ctx2048-b128-thinkOff | responsive-factual | 7089 | 7089 | 0 | no | fallback, fallback-flag, missed-local-fact |
| gemma4:e4b | ctx2048-b128-thinkOff | long-followup | 7564 | 7564 | 0 | no | fallback, fallback-flag |
| gemma4:e4b | ctx2048-b128-thinkOff | guard-threat-assess | 10266 | 4766 | 5496 | yes |  |
| gemma4:e4b | ctx4096-b128-thinkOff | greeting | 7018 | 7018 | 0 | yes |  |
| gemma4:e4b | ctx4096-b128-thinkOff | responsive-factual | 5459 | 5457 | 0 | yes |  |
| gemma4:e4b | ctx4096-b128-thinkOff | long-followup | 6345 | 6344 | 0 | yes |  |
| gemma4:e4b | ctx4096-b128-thinkOff | guard-threat-assess | 12089 | 5355 | 6732 | yes |  |
| gemma4:e4b | ctx8192-b128-thinkOff | greeting | 10293 | 10292 | 0 | yes |  |
| gemma4:e4b | ctx8192-b128-thinkOff | responsive-factual | 8639 | 8639 | 0 | yes |  |
| gemma4:e4b | ctx8192-b128-thinkOff | long-followup | 12057 | 12057 | 0 | no | fallback, fallback-flag |
| gemma4:e4b | ctx8192-b128-thinkOff | guard-threat-assess | 15822 | 7961 | 7861 | yes |  |

## Cold Load Probe

| Model | Config | Wall ms | Load ms | Prompt eval ms | Eval ms | Prompt tokens | Output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:e4b | ctx2048-b128-thinkOff | 5985 | 5764 | 124 | 31 | 14 | 2 |
| gemma4:e4b | ctx4096-b128-thinkOff | 3672 | 3438 | 114 | 27 | 14 | 2 |
| gemma4:e4b | ctx8192-b128-thinkOff | 3650 | 3409 | 115 | 27 | 14 | 2 |

## Cache Check

| Model | Config | Bark refresh ms | Bark cache-hit ms | Cache trace |
| --- | --- | ---: | ---: | --- |
| gemma4:e4b | ctx2048-b128-thinkOff | 1932 | 0 | hit |
| gemma4:e4b | ctx4096-b128-thinkOff | 2484 | 0 | hit |
| gemma4:e4b | ctx8192-b128-thinkOff | 2666 | 0 | hit |

## LiteRT-LM Feasibility

Status: not-benchmarked-no-local-runtime

Google docs describe LiteRT-LM as relevant for session cloning, kv-cache management, prompt caching/scoring, and stateful inference.
The public docs route the detailed CPU/GPU quick start through the LiteRT-LM GitHub repo; the Google page shown in this run focuses on Android NPU setup.
This machine does not have a litertlm executable on PATH. The Python package index lists litert-lm, but no local runtime is installed yet.

## Sources

- https://docs.ollama.com/api/generate
- https://docs.ollama.com/api/chat
- https://ai.google.dev/edge/litert/genai/overview
- https://ai.google.dev/edge/litert/next/litert_lm_npu
- https://huggingface.co/google/gemma-3n-E4B-it-litert-lm
