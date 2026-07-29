# pi-better-read-aloud

OpenAI-compatible text-to-speech tools for Pi.

## Configuration

Configure through environment variables:

- `PI_TTS_URL` or `PI_TTS_BASE_URL`: OpenAI-compatible base URL, for example `https://api.openai.com/v1`, or a full `/audio/speech` URL.
- `PI_TTS_API_KEY`: API key. Falls back to `OPENAI_API_KEY`.
- `PI_TTS_MODEL`: TTS model. Defaults to `tts-1`.
- `PI_TTS_VOICE`: voice. Defaults to `alloy`.
- `PI_TTS_FORMAT`: `mp3`, `wav`, `opus`, `aac`, `flac`, or `pcm`. Defaults to `mp3`.
- `PI_TTS_BODY_FORMAT`: request body format, `json` or `form`. Defaults to `json`; use `form` for form-encoded OpenAI-like proxies.
- `PI_TTS_PLAYER`: local player command. Defaults to `afplay` on macOS and `ffplay` elsewhere.

Tool parameters can override `url`, `api_key`/`apikey`, `model`, `voice`, `format`, `body_format`, `speed`, and `max_chars` per call. The API key is never echoed in tool output.

## Tools

- `read_aloud`: read explicit text.
- `read_aloud_last`: read the latest assistant response in the current session.
- `read_aloud_stop`: stop current playback.

Slash commands:

- `/read-aloud`: read the latest assistant response.
- `/read-aloud some text`: read explicit text.
- `/read-aloud-stop`: stop playback.

The MVP is keyboard/tool driven. Pi's current TUI extension API does not expose stable mouse hover/click events for normal assistant response boxes, so an inline clickable read icon should wait for a core message-action hook or pointer-event support.