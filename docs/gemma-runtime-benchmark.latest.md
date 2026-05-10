# Gemma Runtime Benchmark

Generated: 2026-05-10T15:53:48.911Z

Machine: Apple M5 / 10 (4 Super and 6 Efficiency) CPU cores / 32 GB / 10 GPU cores

Ollama: ollama version is 0.23.2

Models tested: gemma4:e4b-mlx-bf16


## Summary

| Model | Config | Scenario | Median wall ms | Median reply ms | Median analysis ms | Pass | Flags |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOff | greeting | 12931 | 12920 | 0 | yes |  |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOff | responsive-factual | 12000 | 11999 | 0 | yes |  |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOff | guard-threat-assess | 24677 | 15627 | 9043 | yes |  |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOn | greeting | 17541 | 17540 | 0 | no | fallback, fallback-flag |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOn | responsive-factual | 17446 | 17446 | 0 | no | fallback, fallback-flag, missed-local-fact |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOn | guard-threat-assess | 17537 | 17537 | 0 | no | fallback, fallback-flag, missed-call-for-help |

## Cold Load Probe

| Model | Config | Wall ms | Load ms | Prompt eval ms | Eval ms | Prompt tokens | Output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOff | 27864 | 5356 | 22428 | 62 | 14 | 1 |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOn | 7546 | 3645 | 3821 | 77 | 21 | 1 |

## Cache Check

| Model | Config | Bark refresh ms | Bark cache-hit ms | Cache trace |
| --- | --- | ---: | ---: | --- |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOff | 3776 | 0 | hit |
| gemma4:e4b-mlx-bf16 | ctx1024-b128-thinkOn | 5761 | 0 | miss |

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
