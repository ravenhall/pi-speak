import "dotenv/config";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { AzureSpeechProvider } from "./providers/AzureSpeechProvider.js";
import { ElevenLabsProvider } from "./providers/ElevenLabsProvider.js";
import { KokoroProvider } from "./providers/KokoroProvider.js";
import { MacSayProvider } from "./providers/MacSayProvider.js";
import { TTSProvider, TTSProviderName, TTSProviderProgress } from "./types.js";

const DEFAULT_PROVIDER_ORDER: TTSProviderName[] = ["elevenlabs", "azure", "kokoro", "macsay"];
const STATUS_KEY = "pi-speak";
const LOADING_WIDGET_KEY = "pi-speak-loading";

interface PiUi {
  setStatus?: (key: string, value?: string) => void;
  setWidget?: (key: string, value?: string[] | unknown, options?: { placement?: string }) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

interface PiContext {
  hasUI?: boolean;
  ui?: PiUi;
}

class NoopProvider implements TTSProvider {
  async initialize() {}
  streamText(_: string) {}
  flush() {}
  shutdown() {}
  onAudio(_: (audioBase64: string) => void) {}
  onError(_: (error: Error) => void) {}
}

class TTSRuntime {
  private provider: TTSProvider = new NoopProvider();
  private providerIndex = -1;
  private switchingProvider = false;
  private queuedText = "";
  private queuedFlush = false;
  private isShutdown = false;

  constructor(
    private readonly providerOrder: TTSProviderName[],
    private readonly audioCallback: (audioBase64: string) => void,
    private readonly ui: PiSpeakUi
  ) {}

  async initialize() {
    await this.activateProvider(0);
  }

  streamText(text: string) {
    if (this.isShutdown || !text) {
      return;
    }

    if (this.switchingProvider) {
      this.queuedText += text;
      return;
    }

    this.provider.streamText(text);
  }

  flush() {
    if (this.isShutdown) {
      return;
    }

    if (this.switchingProvider) {
      this.queuedFlush = true;
      return;
    }

    this.provider.flush();
  }

  shutdown() {
    this.isShutdown = true;
    this.provider.shutdown();
    this.provider = new NoopProvider();
  }

  private async activateProvider(startIndex: number): Promise<void> {
    for (let index = startIndex; index < this.providerOrder.length; index += 1) {
      const providerName = this.providerOrder[index];
      const provider = createProvider(providerName);

      try {
        this.ui.startProvider(providerName);
        await provider.initialize({
          onProgress: (progress) => this.ui.reportProgress(progress),
        });
        provider.onAudio(this.audioCallback);
        provider.onError((error) => {
          void this.failover(error);
        });

        this.provider = provider;
        this.providerIndex = index;
        this.ui.providerReady(providerName);
        this.replayQueuedInput();
        return;
      } catch (error) {
        provider.shutdown();
        this.ui.providerFailed(providerName, error);
        console.error(`pi-speak: Failed to initialize provider (${providerName})`, error);
      }
    }

    this.ui.noProvider();
    console.error("pi-speak: No TTS providers initialized; audio output disabled.");
    this.provider = new NoopProvider();
    this.providerIndex = this.providerOrder.length;
  }

  private async failover(error: Error) {
    if (this.isShutdown || this.switchingProvider) {
      return;
    }

    this.switchingProvider = true;
    console.error("pi-speak: Active TTS provider failed; attempting fallback", error);
    this.ui.providerFailed(this.providerOrder[this.providerIndex], error);

    const failedProvider = this.provider;
    failedProvider.shutdown();
    this.provider = new NoopProvider();

    await this.activateProvider(this.providerIndex + 1);
    this.switchingProvider = false;
    this.replayQueuedInput();
  }

  private replayQueuedInput() {
    if (!this.queuedText && !this.queuedFlush) {
      return;
    }

    const queuedText = this.queuedText;
    const shouldFlush = this.queuedFlush;
    this.queuedText = "";
    this.queuedFlush = false;

    if (queuedText) {
      this.provider.streamText(queuedText);
    }

    if (shouldFlush) {
      this.provider.flush();
    }
  }
}

class PiSpeakUi {
  private ctx?: PiContext;
  private status: string | undefined;
  private widgetLines: string[] | undefined;

  setContext(ctx: PiContext | undefined) {
    this.ctx = ctx;
    this.renderStatus();
    this.renderWidget();
  }

  startProvider(provider: TTSProviderName) {
    this.setStatus(`initializing ${provider}`);
    this.setWidget([`Initializing ${provider}...`]);
  }

  reportProgress(progress: TTSProviderProgress) {
    const suffix = typeof progress.percent === "number" ? `${progress.percent}%` : progress.message;
    this.setStatus(`loading ${progress.provider} ${suffix}`);
    this.setWidget([progress.message]);
  }

  providerReady(provider: TTSProviderName) {
    this.setStatus(`ready (${provider})`);
    this.setWidget(undefined);
  }

  providerFailed(provider: TTSProviderName | undefined, error: unknown) {
    const providerName = provider ?? "provider";
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(`${providerName} failed`);
    this.setWidget(undefined);
    this.notify(`pi-speak: ${providerName} failed: ${message}`, "warning");
  }

  noProvider() {
    this.setStatus("audio disabled");
    this.setWidget(undefined);
    this.notify("pi-speak: no TTS providers initialized; audio output disabled.", "error");
  }

  clear() {
    this.setStatus(undefined);
    this.setWidget(undefined);
  }

  private get ui() {
    if (this.ctx?.hasUI === false || !this.ctx?.ui) {
      return undefined;
    }

    return this.ctx.ui;
  }

  private setStatus(value: string | undefined) {
    this.status = value;
    this.renderStatus();
  }

  private renderStatus() {
    try {
      this.ui?.setStatus?.(STATUS_KEY, this.status);
    } catch (error) {
      console.error("pi-speak: Failed to update status UI", error);
    }
  }

  private setWidget(lines: string[] | undefined) {
    this.widgetLines = lines;
    this.renderWidget();
  }

  private renderWidget() {
    try {
      this.ui?.setWidget?.(LOADING_WIDGET_KEY, this.widgetLines, { placement: "belowEditor" });
    } catch (error) {
      console.error("pi-speak: Failed to update loading UI", error);
    }
  }

  private notify(message: string, level: "info" | "warning" | "error") {
    try {
      this.ui?.notify?.(message, level);
    } catch (error) {
      console.error("pi-speak: Failed to show notification", error);
    }
  }
}

export default async function(agent: any) {
  let player: ChildProcessWithoutNullStreams | null = null;
  let shuttingDown = false;
  const ui = new PiSpeakUi();
  ui.setContext(agent as PiContext);

  agent.on?.("session_start", (_event: unknown, ctx: PiContext) => {
    ui.setContext(ctx);
  });

  const stopPlayer = (signal: NodeJS.Signals = "SIGKILL") => {
    const currentPlayer = player;
    player = null;

    if (currentPlayer && !currentPlayer.killed) {
      currentPlayer.kill(signal);
    }
  };

  const initPlayer = () => {
    const nextPlayer = spawn("ffplay", [
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-nodisp",
      "-autoexit",
      "-probesize",
      "32",
      "-flags",
      "low_delay",
      "-",
    ]);

    player = nextPlayer;

    nextPlayer.once("error", (error) => {
      if (!shuttingDown) {
        console.error("pi-speak: ffplay failed", error);
      }

      if (player === nextPlayer) {
        player = null;
      }
    });

    nextPlayer.once("close", (code, signal) => {
      if (!shuttingDown && code !== 0 && signal !== "SIGKILL") {
        console.error(`pi-speak: ffplay exited unexpectedly (code=${code}, signal=${signal})`);
      }

      if (player === nextPlayer) {
        player = null;
      }
    });

    nextPlayer.stdin.once("error", (error) => {
      if (!shuttingDown) {
        console.error("pi-speak: ffplay stdin failed", error);
      }

      if (player === nextPlayer) {
        player = null;
      }
    });

    return nextPlayer;
  };

  const writeAudio = (base64: string) => {
    const audio = Buffer.from(base64, "base64");
    const currentPlayer = player ?? initPlayer();

    currentPlayer.stdin.write(audio, (error) => {
      if (error && !shuttingDown) {
        console.error("pi-speak: Failed to write audio to ffplay", error);

        if (player === currentPlayer) {
          stopPlayer();
        }
      }
    });
  };

  const tts = new TTSRuntime(getProviderOrder(), writeAudio, ui);
  await tts.initialize();

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    tts.shutdown();
    ui.clear();
    stopPlayer("SIGTERM");
  };

  process.once("beforeExit", shutdown);
  process.once("SIGINT", () => {
    shutdown();
    process.kill(process.pid, "SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.kill(process.pid, "SIGTERM");
  });

  agent.on("agent:message:delta", (delta: string) => tts.streamText(delta));
  agent.on("agent:message:end", () => tts.flush());
  agent.on("user:input", () => stopPlayer());
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
    case "kokoro":
      return new KokoroProvider();
    case "macsay":
      return new MacSayProvider();
  }
}

function isProviderName(value: string): value is TTSProviderName {
  return value === "elevenlabs" || value === "azure" || value === "kokoro" || value === "macsay";
}
