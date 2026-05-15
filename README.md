# pi-speak

Speech output plugin for the Pi coding agent. The plugin listens to agent message
deltas, sends text to a configured text-to-speech provider, and pipes 24 kHz mono
16-bit PCM audio into `ffplay`.

## Requirements

- Node.js with native `fetch` support.
- `ffplay` available on `PATH` for audio playback.
- macOS `say` is required only when using the `macsay` local fallback.
- Provider credentials for any cloud provider you enable.

## Build

```bash
npm install
npm run build
```

## Provider Selection

Providers are tried in order at startup. The default order is:

```text
elevenlabs,azure,macsay
```

Override the order with either:

```bash
TTS_PROVIDER_ORDER=azure,macsay
TTS_PROVIDER=elevenlabs
```

`TTS_PROVIDER_ORDER` takes precedence over `TTS_PROVIDER`. Unknown names are
ignored. Supported provider names are `elevenlabs`, `azure`, and `macsay`.

If the active provider fails at runtime, `pi-speak` attempts to initialize the
next provider in the configured order. Text received while the fallback provider
is starting is queued and replayed once the new provider is active.

## Environment

| Variable | Provider | Required | Description |
| --- | --- | --- | --- |
| `TTS_PROVIDER_ORDER` | all | no | Comma-separated provider order, for example `elevenlabs,azure,macsay`. |
| `TTS_PROVIDER` | all | no | Single provider or comma-separated fallback order if `TTS_PROVIDER_ORDER` is unset. |
| `ELEVENLABS_API_KEY` | ElevenLabs | yes | ElevenLabs API key. |
| `ELEVENLABS_VOICE_ID` | ElevenLabs | yes | Voice ID used for the `stream-input` WebSocket endpoint. |
| `AZURE_SPEECH_KEY` | Azure | yes | Azure AI Speech subscription key. |
| `AZURE_SPEECH_REGION` | Azure | yes, unless endpoint is set | Azure Speech region used to construct the REST endpoint. |
| `AZURE_SPEECH_ENDPOINT` | Azure | yes, unless region is set | Full Azure Speech REST TTS endpoint override. |
| `AZURE_SPEECH_VOICE` | Azure | no | Azure voice name. Defaults to `en-US-JennyNeural`. |
| `MAC_SAY_VOICE` | macsay | no | macOS voice name passed to `say -v`. Uses the system default when unset. |

## Audio Format

All providers emit base64-encoded raw PCM in this format:

```text
24 kHz, mono, signed 16-bit little-endian PCM
```

The entrypoint starts `ffplay` with matching options:

```bash
ffplay -f s16le -ar 24000 -ac 1 -nodisp -autoexit -probesize 32 -flags low_delay -
```

## Provider Notes

ElevenLabs uses the direct `stream-input` WebSocket protocol and streams audio
as text arrives.

Azure Speech uses the REST text-to-speech endpoint. It buffers deltas and
synthesizes once `agent:message:end` triggers `flush()`.

macOS `say` is a local fallback. It renders a temporary WAVE file, extracts the
PCM data chunk, and sends that through the same playback path. Initialization
fails if `say` produces empty audio, allowing the fallback chain to continue.

## Azure SSO Future Work

Azure Speech currently uses subscription-key authentication. The implementation
contains a detailed `TODO(azure-sso)` in `src/providers/AzureSpeechProvider.ts`
for adding Microsoft Entra ID auth later without breaking the key-based path.
