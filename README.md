# LLM Notifier for Scrypted

Enhance security camera notifications with AI-generated descriptions using vision-capable LLMs.

## Requirements

- The **Large Language Model Plugin** (`@scrypted/llm`) with a vision-capable provider.
- A camera that records, for video playback in the **Brief** and **Activity** tabs. Notifications, descriptions and snapshots work without one.

## Setup

1. Install the **Large Language Model Plugin** (`@scrypted/llm`) from the Scrypted plugin manager and configure a provider with vision support (OpenAI, Claude, Gemini, or any OpenAI-compatible endpoint).
2. Install this plugin: in the Scrypted Management Console, go to **Plugins** in the sidebar, search for `llm-notifier`, and install `@rmaher001/scrypted-llm-notifier`. Pick your provider under **LLM Providers**.
3. On each notification device, open the **Extensions** tab and enable **LLM Notifier**.

Providers are configured in the Large Language Model Plugin's own UI — including local or self-hosted models, via its OpenAI-compatible endpoint option. This plugin only selects from what you have set up there.

Every notification spends one vision-model call. On a cloud provider that is a charge per event — check your provider's image pricing before pointing a busy camera at it.

## Features

### AI Notifications

A vision LLM looks at the snapshot and writes the title and description. Known names from face recognition are preserved, and vehicles are described with make, model, and color when visible.

When several notifiers fire on one event, the image is analyzed once.

Set one or more providers under **LLM Providers**. With several, requests are load-balanced round-robin.

**Notification LLM** is optional: set it to use a different provider for notifications than the rest of the plugin.

### Daily Brief

A web dashboard at `/brief` summarizing the day's activity as an AI-written narrative timeline with video playback.

- Highlights generated per 6-hour period
- **Catch Me Up** for everything since your last visit
- Optional scheduled push notification linking back to the brief

Turn on **Enable Daily Brief Notifications** and pick a **Notifier for Daily Brief** to get the scheduled push. Without a notifier selected nothing is sent.

### Activity

A searchable history of past notifications with poster snapshots and video playback. Filter by camera, type, or person. Click any event to play the clip, with a direct link to the NVR timeline at that moment.

Events that Scrypted grouped into a Story are marked with a **Story** badge.

#### Semantic Search *(optional)*

Add a **Gemini Embedding API Key** to search by visual concept — "red backpack", "person at front door" — instead of keywords. Free key at [Google AI Studio](https://aistudio.google.com/apikey).

### LLM Person Identification *(optional)*

Builds a reference library of known faces from Scrypted's face recognition, then asks the LLM to identify people Scrypted didn't recognize. Reference photos are cropped to the face and ranked by quality, with better photos replacing worse ones over time.

Manage them in the **People** tab. Turn on **LLM Person Identification** to enable.

### LLM Health

Per-call telemetry for every LLM path — success rate, latency percentiles, and quality signals — in the **LLM Health** tab.

Set **Judge Sample Rate** above 0 **and** pick a **Judge LLM Provider** to have a second LLM re-score a sample of notifications for accuracy. Both are required — with no judge provider selected, nothing is scored. Point it at a stronger model than your notification LLM, or the grade is just the same model marking its own work.

## Settings

- **LLM Providers** — vision-capable LLMs, load-balanced. *Required.*
- **Notification LLM** — *optional.* A different provider for notifications. *Default: uses LLM Providers.*
- **Enable Notifications** — master switch; off passes notifications through unchanged. *Default: on.*
- **Snapshot Mode** — cropped, full, or both. *Default: full.*
- **LLM Timeout (sec)** — per-call timeout. *Default: 90.*
- **Notification Style** — *optional.* Override the built-in wording instructions. *Default: built-in.*
- **LLM Person Identification** — *optional.* Identify faces Scrypted didn't recognize. *Default: off.*
- **Enable Daily Brief Notifications** — *optional.* Send the scheduled summary. *Default: off.*
- **Notifier for Daily Brief** — *optional.* Which notifier sends it. *Default: none; required for the scheduled summary to be sent.*
- **Notification Time (Hour)** — *optional.* Hour to send the summary, 0–23. *Default: 20.*
- **Notification Click URL** — *optional, HA notifiers only.* Opened when the Daily Brief notification is tapped; set it to the HA dashboard path where your Daily Brief card lives. Also the base path for per-event taps below. *Default: `/daily-brief/0`.*
- **Open Event on Tap (HA only)** — *optional.* Tapping an enhanced notification opens the dashboard above at that event in the Activity tab. *Default: off.*
- **Activity Retention (Days)** — how long events and posters are kept. *Default: 3.*
- **Gemini Embedding API Key** — *optional.* Enables semantic search. *Default: empty.*
- **HA NVR Timeline Path** — *optional.* Dashboard path for the NVR card below. *Default: empty.*
- **Judge Sample Rate** — *optional.* Fraction of calls re-scored, 0–1. *Default: 0.*
- **Judge LLM Provider** — *optional.* Provider that re-scores them. *Default: unset — judging is skipped entirely until you pick one.*

## Home Assistant

You'll need your Scrypted token: **Settings → Devices & Services → Scrypted**. Replace `TOKEN` below.

### 1. Add the resource

**Settings → Dashboards → Resources → Add Resource**, type **JavaScript Module**:

```
/api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier/assets/daily-brief-card.js
```

This one resource provides both cards below.

### 2. Add the Daily Brief

Use `type: panel` — other view types squeeze the card into a narrow column. In a dashboard's raw YAML editor:

```yaml
views:
  - title: Daily Brief
    type: panel
    cards:
      - type: custom:daily-brief-card
        endpoint: /api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier
        scrypted_token: TOKEN
```

### 3. NVR timeline in HA *(optional)*

Without this, NVR links open in a browser. On iPhone that leaves the HA app. This keeps them in-app.

Create a **second** dashboard (for example at path `scrypted`) with:

```yaml
views:
  - title: NVR
    type: panel
    cards:
      - type: custom:scrypted-nvr-iframe-card
        url_template: "https://YOUR_SCRYPTED_HOST/endpoint/YOUR_TOKEN/@scrypted/nvr/public/#/timeline/{camera}?time={time}"
```

`{camera}` and `{time}` are the only placeholders, filled in per event. Add `default_url` if you want a fallback when an event supplies neither.

Then set **HA NVR Timeline Path** to that dashboard's path (`/scrypted`).

## Troubleshooting

- **No enhancement** — confirm the provider's model supports vision.
- **Timeouts** — raise **LLM Timeout (sec)**, or use a faster provider.
- **Stale HA card** — clear the browser cache, then check the browser console for `Daily Brief Card v… loaded` to confirm which version is running.
- **Plain notifications on iPhone/Mac** — the Scrypted apps send a text-only preview before the enriched one. Turn off **Immediate Notifications** under **NVR → Preferences → Users → Notification Device**.
