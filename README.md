# LLM Notifier for Scrypted

Enhance security camera notifications with AI-generated descriptions using vision-capable LLMs.

## Setup
1. **Install LLM Plugin** - Required dependency for ChatCompletion providers
2. **Configure LLM Provider** - Select OpenAI, Claude, or local LLM in settings
3. **Enable on Devices** - Extensions → toggle on your notification devices
4. **Test** - Trigger a detection to see enhanced notifications

## Settings
- **LLM Providers**: Select one or more (rotates between them for load balancing)
- **Notification Style**: Customize how detections are described
- **Snapshot Mode**: Cropped (fast), Full (context), or Both (accurate)

## Features
- **Face Recognition**: Preserves names from face detection metadata
- **Vehicle Details**: Make, model, color, and license plates when visible
- **Smart Caching**: Reduces redundant LLM calls by 75% with multiple notifiers
- **Platform Support**: Works with any Notifier device (Pushover, Home Assistant, etc.)

## Troubleshooting
- **No enhancement**: Check LLM provider is vision-capable
- **Timeouts**: Reduce LLM timeout or use single provider
- **Wrong names**: Ensure "Include Original Message" is enabled
