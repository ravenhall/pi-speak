"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
require("dotenv/config");
const child_process_1 = require("child_process");
const AzureSpeechProvider_js_1 = require("./providers/AzureSpeechProvider.js");
const ElevenLabsProvider_js_1 = require("./providers/ElevenLabsProvider.js");
const KokoroProvider_js_1 = require("./providers/KokoroProvider.js");
const MacSayProvider_js_1 = require("./providers/MacSayProvider.js");
const DEFAULT_PROVIDER_ORDER = ["elevenlabs", "azure", "kokoro", "macsay"];
class NoopProvider {
    async initialize() { }
    streamText(_) { }
    flush() { }
    shutdown() { }
    onAudio(_) { }
    onError(_) { }
}
class TTSRuntime {
    providerOrder;
    audioCallback;
    provider = new NoopProvider();
    providerIndex = -1;
    switchingProvider = false;
    queuedText = "";
    queuedFlush = false;
    isShutdown = false;
    constructor(providerOrder, audioCallback) {
        this.providerOrder = providerOrder;
        this.audioCallback = audioCallback;
    }
    async initialize() {
        await this.activateProvider(0);
    }
    streamText(text) {
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
    async activateProvider(startIndex) {
        for (let index = startIndex; index < this.providerOrder.length; index += 1) {
            const providerName = this.providerOrder[index];
            const provider = createProvider(providerName);
            try {
                await provider.initialize();
                provider.onAudio(this.audioCallback);
                provider.onError((error) => {
                    void this.failover(error);
                });
                this.provider = provider;
                this.providerIndex = index;
                console.log(`pi-speak: Provider initialized (${providerName}).`);
                this.replayQueuedInput();
                return;
            }
            catch (error) {
                provider.shutdown();
                console.error(`pi-speak: Failed to initialize provider (${providerName})`, error);
            }
        }
        console.error("pi-speak: No TTS providers initialized; audio output disabled.");
        this.provider = new NoopProvider();
        this.providerIndex = this.providerOrder.length;
    }
    async failover(error) {
        if (this.isShutdown || this.switchingProvider) {
            return;
        }
        this.switchingProvider = true;
        console.error("pi-speak: Active TTS provider failed; attempting fallback", error);
        const failedProvider = this.provider;
        failedProvider.shutdown();
        this.provider = new NoopProvider();
        await this.activateProvider(this.providerIndex + 1);
        this.switchingProvider = false;
        this.replayQueuedInput();
    }
    replayQueuedInput() {
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
async function default_1(agent) {
    let player = null;
    let shuttingDown = false;
    const stopPlayer = (signal = "SIGKILL") => {
        const currentPlayer = player;
        player = null;
        if (currentPlayer && !currentPlayer.killed) {
            currentPlayer.kill(signal);
        }
    };
    const initPlayer = () => {
        const nextPlayer = (0, child_process_1.spawn)("ffplay", [
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
    const writeAudio = (base64) => {
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
    const tts = new TTSRuntime(getProviderOrder(), writeAudio);
    await tts.initialize();
    const shutdown = () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        tts.shutdown();
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
    agent.on("agent:message:delta", (delta) => tts.streamText(delta));
    agent.on("agent:message:end", () => tts.flush());
    agent.on("user:input", () => stopPlayer());
}
function getProviderOrder() {
    const configuredOrder = process.env.TTS_PROVIDER_ORDER ?? process.env.TTS_PROVIDER;
    if (!configuredOrder) {
        return DEFAULT_PROVIDER_ORDER;
    }
    const seen = new Set();
    const orderedProviders = [];
    for (const provider of configuredOrder.split(",")) {
        const normalized = provider.trim().toLowerCase();
        if (isProviderName(normalized) && !seen.has(normalized)) {
            seen.add(normalized);
            orderedProviders.push(normalized);
        }
    }
    return orderedProviders.length > 0 ? orderedProviders : DEFAULT_PROVIDER_ORDER;
}
function createProvider(providerName) {
    switch (providerName) {
        case "elevenlabs":
            return new ElevenLabsProvider_js_1.ElevenLabsProvider();
        case "azure":
            return new AzureSpeechProvider_js_1.AzureSpeechProvider();
        case "kokoro":
            return new KokoroProvider_js_1.KokoroProvider();
        case "macsay":
            return new MacSayProvider_js_1.MacSayProvider();
    }
}
function isProviderName(value) {
    return value === "elevenlabs" || value === "azure" || value === "kokoro" || value === "macsay";
}
