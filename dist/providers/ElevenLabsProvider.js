"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElevenLabsProvider = void 0;
const ws_1 = __importDefault(require("ws"));
class ElevenLabsProvider {
    socket = null;
    openingSocket = null;
    audioCallback;
    errorCallback;
    isShutdown = false;
    apiKey;
    streamUrl;
    pendingText = "";
    pendingFlush = false;
    expectedClose = false;
    async initialize() {
        const voiceId = process.env.ELEVENLABS_VOICE_ID;
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!voiceId) {
            throw new Error("ELEVENLABS_VOICE_ID is required");
        }
        if (!apiKey) {
            throw new Error("ELEVENLABS_API_KEY is required");
        }
        const params = new URLSearchParams({
            model_id: "eleven_flash_v2_5",
            output_format: "pcm_24000",
            optimize_streaming_latency: "3",
        });
        const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?${params.toString()}`;
        this.apiKey = apiKey;
        this.streamUrl = url;
    }
    streamText(text) {
        if (!text || this.isShutdown) {
            return;
        }
        this.pendingText += text;
        this.ensureSocket();
        this.drainPendingInput();
    }
    flush() {
        if (this.isShutdown) {
            return;
        }
        this.pendingFlush = true;
        this.ensureSocket();
        this.drainPendingInput();
    }
    onAudio(callback) {
        this.audioCallback = callback;
    }
    onError(callback) {
        this.errorCallback = callback;
    }
    shutdown() {
        this.isShutdown = true;
        this.expectedClose = true;
        this.socket?.close();
        this.socket = null;
        this.openingSocket = null;
        this.pendingText = "";
        this.pendingFlush = false;
    }
    ensureSocket() {
        if (this.isShutdown || this.socket?.readyState === ws_1.default.OPEN || this.openingSocket) {
            return;
        }
        if (!this.streamUrl || !this.apiKey) {
            this.reportError(new Error("ElevenLabs provider was not initialized"));
            return;
        }
        this.expectedClose = false;
        const socket = new ws_1.default(this.streamUrl);
        this.socket = socket;
        socket.on("message", (data) => {
            const message = this.parseMessage(data);
            if (message?.audio) {
                this.audioCallback?.(message.audio);
            }
            if (message?.isFinal) {
                this.expectedClose = true;
                socket.close();
            }
        });
        socket.on("error", (error) => {
            console.error("pi-speak: ElevenLabs WebSocket error", error);
            this.reportError(error);
        });
        socket.on("close", (code, reason) => {
            if (this.socket === socket) {
                this.socket = null;
            }
            this.openingSocket = null;
            if (this.isShutdown || this.expectedClose || code === 1000) {
                this.expectedClose = false;
                return;
            }
            const error = new Error(`ElevenLabs WebSocket closed unexpectedly (${code}) ${reason.toString()}`);
            console.error(`pi-speak: ${error.message}`);
            this.reportError(error);
        });
        this.openingSocket = new Promise((resolve, reject) => {
            const handleOpen = () => {
                socket.send(JSON.stringify({
                    text: " ",
                    xi_api_key: this.apiKey,
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.8,
                    },
                }), (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            };
            const handleError = (error) => {
                reject(error);
            };
            socket.once("open", handleOpen);
            socket.once("error", handleError);
        });
        this.openingSocket
            .then(() => {
            if (this.socket === socket) {
                this.openingSocket = null;
                this.drainPendingInput();
            }
        })
            .catch((error) => {
            if (this.socket === socket) {
                this.socket = null;
            }
            this.openingSocket = null;
            socket.close();
            this.reportError(toError(error));
        });
    }
    drainPendingInput() {
        if (this.socket?.readyState !== ws_1.default.OPEN) {
            return;
        }
        const text = this.pendingText;
        const shouldFlush = this.pendingFlush;
        this.pendingText = "";
        this.pendingFlush = false;
        if (text) {
            this.socket.send(JSON.stringify({
                text,
                try_trigger_generation: true,
            }), (error) => {
                if (error) {
                    this.reportError(error);
                }
            });
        }
        if (shouldFlush) {
            this.socket.send(JSON.stringify({
                text: "",
                flush: true,
            }), (error) => {
                if (error) {
                    this.reportError(error);
                }
            });
        }
    }
    reportError(error) {
        if (!this.isShutdown) {
            this.errorCallback?.(error);
        }
    }
    parseMessage(data) {
        try {
            const raw = typeof data === "string"
                ? data
                : Buffer.isBuffer(data)
                    ? data.toString("utf8")
                    : Array.isArray(data)
                        ? Buffer.concat(data).toString("utf8")
                        : Buffer.from(data).toString("utf8");
            return JSON.parse(raw);
        }
        catch (error) {
            console.error("pi-speak: Failed to parse ElevenLabs message", error);
            return null;
        }
    }
}
exports.ElevenLabsProvider = ElevenLabsProvider;
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
