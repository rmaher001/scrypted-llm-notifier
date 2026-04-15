# Local Models

The plugin works with local LLMs served via [Ollama](https://ollama.com) or any OpenAI-compatible API. However, local models produce significantly less detailed notifications than cloud models like Gemini Flash.

## What to expect

Cloud vision models (Gemini Flash, GPT-4o) identify people by name, describe clothing, actions, and objects held, and read license plates — all in 3-9 seconds. Local models typically produce generic descriptions like "a person is in the room" and miss most details. Person identification via reference photos requires strong vision capabilities that local models currently lack.

Local models are best suited for users who prioritize privacy or cost over description quality.

## Setup with Ollama

1. Install [Ollama](https://ollama.com) and pull a vision-capable model
2. In Scrypted, install an OpenAI-compatible LLM plugin and configure it with your Ollama endpoint: `http://<ollama-host>:11434/v1/chat/completions`
3. Select that LLM in the LLM Notifier plugin settings

## Context window

Ollama defaults to a 2048 token context window regardless of model capability. This is too small for Daily Brief generation (which sends many events in a single prompt) and will cause empty or failed responses.

Create a custom Modelfile to increase the context window:

```
FROM gemma3:12b
PARAMETER num_ctx 8192
```

Then: `ollama create gemma3:12b-8k -f Modelfile`

Set `num_ctx` based on your available RAM — 8192 is a safe starting point, 16384 or higher if you have memory to spare.

## Recommended models

Non-thinking models work best. Thinking models (Gemma 4 26B-A4B, Qwen 3.5) have a known [Ollama bug](https://github.com/ollama/ollama/issues/15260) where structured JSON output fails when thinking mode is active.

| Model | RAM (4-bit) | Speed | Notes |
|-------|-------------|-------|-------|
| `gemma3:12b` | ~7GB | ~10s | Best balance of speed, quality, and compatibility |
| `gemma4:31b` | ~17GB | ~35s | Better vision than Gemma 3, but slower |
| `gemma4:e4b` | ~5GB | ~12s | Fast but very basic descriptions |
| `gemma4:26b` | ~14GB | ~29s | Avoid — thinking mode breaks structured output in Ollama |

## Benchmark results (April 2026)

Tested on 5 camera images (indoor person, kitchen, garage, street vehicle, sidewalk) comparing Gemini Flash against local models via Ollama on M4 Mac (64GB):

| Model | Person ID | Detail level | Clarity scoring | Speed |
|-------|-----------|-------------|-----------------|-------|
| Gemini Flash | Names people, high confidence | Clothing, actions, objects, license plates | Structured {score, reason} | 3-9s |
| gemma4:31b | Generic ("a woman") | Basic scene description | Often 0 or missing | 30-43s |
| gemma4:e4b | Rarely notices people | Very generic | Always 0 | 8-16s |
| gemma4:e2b | Barely notices people | Minimal | Always 0 | 6-7s |

### Example comparison

**Image: Person in garage with two SUVs**

- **Flash**: "Person in garage — Standing by a grey SUV while holding a small white object" (clarity 9/10, correctly identified the person by name)
- **gemma4:31b**: "Garage Activity — Two grey cars are parked side-by-side in the garage" (missed person entirely)
- **gemma4:e4b**: "Garage Scene — Two cars are visible inside a garage" (missed person)

## Future: Fine-tuning

A fine-tuned local model could potentially close the quality gap. The plugin stores thousands of notifications with Gemini Flash descriptions that could serve as training data. This remains an area for future experimentation.
