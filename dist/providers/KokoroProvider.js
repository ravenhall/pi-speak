"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KokoroProvider = void 0;
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_DTYPE = "q8";
const DEFAULT_DEVICE = "cpu";
const DEFAULT_VOICE = "af_heart";
const DEFAULT_SPEED = 1;
const OUTPUT_SAMPLE_RATE = 24000;
class KokoroProvider {
    tts = null;
    audioCallback;
    errorCallback;
    buffer = "";
    synthesisQueue = Promise.resolve();
    isShutdown = false;
    voice = DEFAULT_VOICE;
    speed = DEFAULT_SPEED;
    async initialize(options = {}) {
        const modelId = process.env.KOKORO_MODEL_ID || DEFAULT_MODEL_ID;
        const dtype = parseDtype(process.env.KOKORO_DTYPE);
        const device = parseDevice(process.env.KOKORO_DEVICE);
        const KokoroTTS = loadKokoroTTS();
        this.voice = (process.env.KOKORO_VOICE || DEFAULT_VOICE);
        this.speed = parsePositiveNumber(process.env.KOKORO_SPEED, DEFAULT_SPEED);
        this.tts = await KokoroTTS.from_pretrained(modelId, {
            dtype,
            device,
            progress_callback: (progress) => {
                if (progress.status === "progress" && typeof progress.progress === "number") {
                    const percent = Math.round(progress.progress);
                    options.onProgress?.({
                        provider: "kokoro",
                        message: `Kokoro model loading ${percent}%`,
                        percent,
                    });
                }
            },
        });
        if (!this.tts.voices[this.voice]) {
            throw new Error(`Unknown Kokoro voice: ${this.voice}`);
        }
    }
    streamText(text) {
        this.buffer += text;
    }
    flush() {
        const text = this.buffer.trim();
        this.buffer = "";
        if (!text || this.isShutdown) {
            return;
        }
        this.synthesisQueue = this.synthesisQueue
            .then(() => this.synthesize(text))
            .catch((error) => {
            console.error("pi-speak: Kokoro synthesis failed", error);
            this.reportError(toError(error));
        });
    }
    onAudio(callback) {
        this.audioCallback = callback;
    }
    onError(callback) {
        this.errorCallback = callback;
    }
    shutdown() {
        this.isShutdown = true;
        this.buffer = "";
        this.tts = null;
    }
    async synthesize(text) {
        if (!this.tts) {
            throw new Error("Kokoro provider is not initialized");
        }
        const audio = await this.tts.generate(text, {
            voice: this.voice,
            speed: this.speed,
        });
        const samples = audio.sampling_rate === OUTPUT_SAMPLE_RATE
            ? audio.audio
            : resampleLinear(audio.audio, audio.sampling_rate, OUTPUT_SAMPLE_RATE);
        const pcm = floatToPcm16Le(samples);
        if (!this.isShutdown) {
            this.audioCallback?.(pcm.toString("base64"));
        }
    }
    reportError(error) {
        if (!this.isShutdown) {
            this.errorCallback?.(error);
        }
    }
}
exports.KokoroProvider = KokoroProvider;
function parseDtype(value) {
    switch (value) {
        case "fp32":
        case "fp16":
        case "q8":
        case "q4":
        case "q4f16":
            return value;
        case undefined:
        case "":
            return DEFAULT_DTYPE;
        default:
            throw new Error(`Invalid KOKORO_DTYPE: ${value}`);
    }
}
function loadKokoroTTS() {
    const { KokoroTTS } = require("kokoro-js");
    return KokoroTTS;
}
function parseDevice(value) {
    switch (value) {
        case "wasm":
        case "webgpu":
        case "cpu":
            return value;
        case "auto":
        case "null":
            return null;
        case undefined:
        case "":
            return DEFAULT_DEVICE;
        default:
            throw new Error(`Invalid KOKORO_DEVICE: ${value}`);
    }
}
function parsePositiveNumber(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive number, received: ${value}`);
    }
    return parsed;
}
function resampleLinear(input, inputRate, outputRate) {
    if (input.length === 0 || inputRate === outputRate) {
        return input;
    }
    const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let index = 0; index < outputLength; index += 1) {
        const sourceIndex = index * ratio;
        const lower = Math.floor(sourceIndex);
        const upper = Math.min(lower + 1, input.length - 1);
        const weight = sourceIndex - lower;
        output[index] = input[lower] * (1 - weight) + input[upper] * weight;
    }
    return output;
}
function floatToPcm16Le(samples) {
    const pcm = Buffer.allocUnsafe(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        pcm.writeInt16LE(Math.round(scaled), index * 2);
    }
    return pcm;
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
