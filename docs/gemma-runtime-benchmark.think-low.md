# Gemma Runtime Benchmark

Generated: 2026-05-10T15:59:36.911Z

Machine: Apple M5 / 10 (4 Super and 6 Efficiency) CPU cores / 32 GB / 10 GPU cores

Ollama: ollama version is 0.23.2

Models tested: gemma4:e4b


## Summary

| Model | Config | Scenario | Median wall ms | Median reply ms | Median analysis ms | Pass | Flags |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| gemma4:e4b | ctx4096-b128-thinkLow | greeting | 10004 | 10004 | 0 | no | fallback, fallback-flag |
| gemma4:e4b | ctx4096-b128-thinkLow | responsive-factual | 7031 | 7030 | 0 | no | fallback, fallback-flag, missed-local-fact |
| gemma4:e4b | ctx4096-b128-thinkLow | long-followup | 7875 | 7875 | 0 | no | fallback, fallback-flag |
| gemma4:e4b | ctx4096-b128-thinkLow | guard-threat-assess | 7809 | 7809 | 0 | no | fallback, fallback-flag, missed-call-for-help |

## Cold Load Probe

| Model | Config | Wall ms | Load ms | Prompt eval ms | Eval ms | Prompt tokens | Output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:e4b | ctx4096-b128-thinkLow | 3540 | 3312 | 111 | 29 | 21 | 2 |

## Cache Check

| Model | Config | Bark refresh ms | Bark cache-hit ms | Cache trace |
| --- | --- | ---: | ---: | --- |
| gemma4:e4b | ctx4096-b128-thinkLow | 2985 | 0 | miss |

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
