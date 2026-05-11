# Gemma Runtime Benchmark

Generated: 2026-05-11T01:07:00.244Z

Machine: Apple M5 / 10 (4 Super and 6 Efficiency) CPU cores / 32 GB / 10 GPU cores

Ollama: ollama version is 0.23.2

Models tested: gemma4:e4b
oMLX models tested: gemma-4-E4B-it-MLX-8bit
LiteRT-LM models tested: gemma4-e4b-litert






## Summary

| Runtime | Model | Config | Scenario | Median wall ms | Median reply ms | Median analysis ms | Pass | Flags |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | greeting | 7860 | 7853 | 0 | yes |  |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | responsive-factual | 4729 | 4728 | 0 | yes |  |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | long-followup | 5877 | 5877 | 0 | yes |  |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | guard-threat-assess | 11032 | 5183 | 5843 | yes |  |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | greeting | 5852 | 5852 | 0 | yes |  |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | responsive-factual | 6233 | 6233 | 0 | yes |  |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | long-followup | 4920 | 4919 | 0 | yes |  |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | guard-threat-assess | 15748 | 12011 | 3735 | yes |  |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | greeting | 11904 | 11904 | 0 | yes |  |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | responsive-factual | 13627 | 13626 | 0 | yes |  |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | long-followup | 14543 | 14536 | 0 | yes |  |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | guard-threat-assess | 26058 | 13562 | 12483 | yes |  |

## Cold Load Probe

| Runtime | Model | Config | Wall ms | Load ms | Prompt eval ms | Eval ms | Prompt tokens | Output tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | 6274 | 6014 | 126 | 29 | 14 | 2 |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | 1412 |  |  |  | 14 | 1 |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | 5617 |  |  |  |  |  |

## Cache Check

| Runtime | Model | Config | Bark refresh ms | Bark cache-hit ms | Cache trace |
| --- | --- | --- | ---: | ---: | --- |
| ollama | gemma4:e4b | ollama-ctx4096-q4-thinkOff | 2494 | 0 | hit |
| omlx | gemma-4-E4B-it-MLX-8bit | omlx-json_schema | 1526 | 0 | hit |
| litert-lm | gemma4-e4b-litert | litert-gpu-ctx4096 | 5753 | 0 | hit |

## LiteRT-LM Feasibility

Status: benchmarked-local-runtime

LiteRT-LM command: /Users/dmitrylyalin/Source/Games/the-world/.venv/litert-lm/bin/litert-lm
Installed models: gemma4-e4b-litert
Benchmark closes the persistent LiteRT bridge after each config to avoid holding memory across runtime comparisons.

## Sources

- https://docs.ollama.com/api/generate
- https://docs.ollama.com/api/chat
- https://ai.google.dev/edge/litert/genai/overview
- https://ai.google.dev/edge/litert/next/litert_lm_npu
- https://huggingface.co/google/gemma-3n-E4B-it-litert-lm
