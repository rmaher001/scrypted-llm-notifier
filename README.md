# LLM Notifier for Scrypted

Enhance security camera notifications with AI-generated descriptions using vision-capable LLMs.

## Setup

1. Install the **Scrypted LLM Plugin** from the Scrypted plugin manager
2. Select an LLM provider (OpenAI, Claude, Gemini, or local) in plugin settings
3. Enable on your notification devices via the **Extensions** tab on each device

## Features

### AI Notifications
Vision LLM analyzes notification snapshots and generates contextual titles and descriptions. Preserves known names from face recognition and describes vehicles with make/model/color when visible.

When multiple notifiers are triggered by the same event, only one AI analysis is performed.

### Notification Grouping *(optional)*
Buffer notifications for a configurable window and group related events into a single notification via LLM. Reduces notification spam when multiple cameras trigger on the same activity.

Enable by setting **Grouping Window** to a value greater than 0.

### Daily Brief *(optional)*
A web dashboard that summarizes your day's camera activity into an AI-generated narrative timeline with video clip playback.

- Time-bucketed segments with highlights
- **Catch Me Up** button for incremental updates since last visit
- Scheduled push notification with a link to the brief

Enable daily notifications by turning on **Enable Daily Brief Notifications** in settings.

### Gallery
A searchable history of all past notifications with poster-quality snapshots and video playback. Filter by camera, type, or person — and optionally enable semantic search to find events by visual description.

#### Semantic Search *(optional)*
Add a **Gemini Embedding API Key** in settings to upgrade from keyword search to full semantic search — find events by visual concepts like "red backpack" or "person at front door".

Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).

### LLM Person Identification *(optional)*
Builds a reference library of known faces from Scrypted's face recognition data, then uses the LLM to identify unrecognized people in future notifications.

Enable by turning on **LLM Person Identification** in settings.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| LLM Providers | Vision-capable LLMs (load-balanced) | *(required)* |
| Snapshot Mode | Cropped, Full, or Both | Cropped |
| Grouping Window | Buffer seconds before grouping (0 = off) | 0 |
| LLM Person Identification | Use LLM to identify unknown faces | Off |
| Enable Daily Brief Notifications | Send scheduled daily summary | Off |
| Brief Schedule | Hour to send daily notification | 8 PM |
| Gallery Retention | Days to keep events and posters | 3 |
| Gemini Embedding API Key | Enables semantic search in Gallery | *(empty)* |

## HA Card Setup

Display the Daily Brief as a Home Assistant Lovelace card.

> **You'll need your Scrypted token.** Find it in Home Assistant under **Settings → Devices & Services → Scrypted**. Replace `TOKEN` in both steps below.

### Step 1: Add Lovelace Resource

1. In Home Assistant, go to **Settings → Dashboards → Resources** (top right)
2. Click **Add Resource**
3. URL:
   ```
   /api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier/assets/daily-brief-card.js
   ```
4. Resource type: **JavaScript Module**

### Step 2: Create a Panel Dashboard

Use `type: panel` so the card gets full width. Other view types constrain it to a narrow column.

Open a dashboard's raw YAML editor and paste:

```yaml
views:
  - title: Daily Brief
    type: panel
    cards:
      - type: custom:daily-brief-card
        endpoint: /api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier
        scrypted_token: TOKEN
```

## Troubleshooting

- **No enhancement**: Check your LLM plugin settings and confirm a model with vision support is selected
- **Timeouts**: Increase the **LLM Timeout** value in plugin settings, or switch to a faster provider
- **Stale HA card**: Clear browser cache or check card version in footer
