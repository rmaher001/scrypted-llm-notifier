# LLM Notifier for Scrypted

Enhance security camera notifications with AI-generated descriptions using vision-capable LLMs.

### New: Daily Brief

An AI-curated dashboard that summarizes your day's camera activity into a narrative timeline with video clip playback. Available as a standalone web UI and a Home Assistant Lovelace card.

## Setup

1. Install the **Scrypted LLM Plugin** (provides ChatCompletion interface)
2. Select an LLM provider (OpenAI, Claude, or local) in plugin settings
3. Enable on your notification devices via Extensions

## Features

- **AI Notifications** - Vision LLM analyzes detection images to generate contextual titles and descriptions
- **Face & Vehicle Recognition** - Preserves known names, describes vehicles with make/model/color
- **Smart Caching** - Deduplicates LLM calls across multiple notifiers (4 notifiers = 1 LLM call)
- **Daily Brief** - LLM-curated summary of the day's camera activity with narrative timeline, highlights, and video clip playback
- **Home Assistant Card** - Custom Lovelace card for the Daily Brief with auto-updating loader

## Daily Brief

A web dashboard and HA card that provides an AI-generated narrative of your day's camera activity.

- **Narrative timeline** with time-bucketed segments
- **Video clip playback** for detection events
- **Catch Me Up** button for incremental updates since last visit
- **Scheduled notifications** to your phone with a link to the brief

Access via Scrypted UI, Home Assistant card, or direct URL.

## Settings

| Setting | Description |
|---------|-------------|
| LLM Providers | One or more vision-capable LLMs (load-balanced) |
| Snapshot Mode | Cropped (fast), Full (context), or Both (accurate) |
| Daily Brief Cameras | Which cameras to include in the brief |
| Brief Schedule | Hour to send daily notification (default: 8 PM) |

## Troubleshooting

- **No enhancement**: Verify LLM provider is vision-capable
- **Timeouts**: Reduce timeout or switch providers
- **Stale HA card**: Clear browser cache or check card version in footer
