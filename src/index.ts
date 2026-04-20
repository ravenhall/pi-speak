import "dotenv/config";
import { spawn, ChildProcess } from "child_process";
import { AzureSpeechProvider } from "./providers/AzureSpeechProvider.js";
import { ElevenLabsProvider } from "./providers/ElevenLabsProvider.js";
import { MacSayProvider } from "./providers/MacSayProvider.js";
import { TTSProvider, TTSProviderName } from "./types.js";

const DEFAULT_PROVIDER_ORDER: TTSProviderName[] = ["elevenlabs", "azure", "macsay"];

class NoopProvider implements TTSProvider {
  async initialize() {}
  streamText(_: string) {}
  flush() {}
  shutdown() {}
  onAudio(_: (audioBase64: string) => void) {}
}

export default async function(agent: any) {
  let player: ChildProcess | null = null;

  const initPlayer = () => {
    player = spawn("ffplay", [
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-nodisp",
      "-probesize",
      "32",
      "-flags",
      "low_delay",
      "-",
    ]);
  };

  const tts = await initializeProvider();

  tts.onAudio((base64) => {
    if (!player) {
      initPlayer();
    }

    player?.stdin?.write(Buffer.from(base64, "base64"));
  });

  agent.on("agent:message:delta", (delta: string) => tts.streamText(delta));
  agent.on("agent:message:end", () => tts.flush());

  agent.on("user:input", () => {
    if (player) {
      player.kill("SIGKILL");
      player = null;
    }
  });
}

async function initializeProvider() {
  const providerOrder = getProviderOrder();

  for (const providerName of providerOrder) {
    const provider = createProvider(providerName);

    try {
      await provider.initialize();
      console.log(`pi-speak: Provider initialized (${providerName}).`);
      return provider;
    } catch (error) {
      provider.shutdown();
      console.error(`pi-speak: Failed to initialize provider (${providerName})`, error);
    }
  }

  console.error("pi-speak: No TTS providers initialized; audio output disabled.");
  return new NoopProvider();
}

function getProviderOrder(): TTSProviderName[] {
  const configuredOrder = process.env.TTS_PROVIDER_ORDER ?? process.env.TTS_PROVIDER;

  if (!configuredOrder) {
    return DEFAULT_PROVIDER_ORDER;
  }

  const seen = new Set<TTSProviderName>();
  const orderedProviders: TTSProviderName[] = [];

  for (const provider of configuredOrder.split(",")) {
    const normalized = provider.trim().toLowerCase();

    if (isProviderName(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      orderedProviders.push(normalized);
    }
  }

  return orderedProviders.length > 0 ? orderedProviders : DEFAULT_PROVIDER_ORDER;
}

function createProvider(providerName: TTSProviderName) {
  switch (providerName) {
    case "elevenlabs":
      return new ElevenLabsProvider();
    case "azure":
      return new AzureSpeechProvider();
    case "macsay":
      return new MacSayProvider();
  }
}

function isProviderName(value: string): value is TTSProviderName {
  return value === "elevenlabs" || value === "azure" || value === "macsay";
}
