# LLM Notifier for Scrypted

## Installation
In Scrypted, search for and install: `scrypted-llm-notifier`

## Configuration

## Settings
- General
  - LLM Providers: select one or more providers from the LLM Plugin
    - Multiple providers: rotates between them to spread the load
    - If an LLM fails or times out, sends the original notification instead
  - System Prompt: try the default—it's ready out of the box, or feel free to customize it
- Advanced
  - Enable LLM Enhancement: On
  - Snapshot Mode:
    - Cropped: zoomed subject; fastest
    - Full: full frame for scene context
    - Both (default): full + cropped
      - Why Both: full frame drives location/scene; cropped adds clear subject details (auto‑downscaled for speed)
  - LLM Timeout (sec): 90
  - Include Original Message: On (preserves face recognition names from notifications)

## Enable on Devices
- Extensions → toggle on your notification devices (mobile apps, pushover, etc.)

## Verify
- Trigger a detection with an image; notification shows "Subject • Location" with concise details

## Default Prompt
The default system prompt is optimized for Android/iOS notifications with strict character limits (32/32/60). It automatically:
- Identifies people, vehicles (make/model when visible), and animals (breeds when clear)
- Preserves face recognition names from "Maybe: [name]" metadata
- Uses consistent location naming (Driveway, Front yard, etc.)
- Formats as: Title (action), Subtitle (subject • location), Body (details)
