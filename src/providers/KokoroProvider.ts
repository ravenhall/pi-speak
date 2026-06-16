import { TTSProvider, TTSProviderInitializeOptions } from "../types.js";

const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_DTYPE = "q8";
const DEFAULT_DEVICE = "cpu";
const DEFAULT_VOICE = "af_heart";
const DEFAULT_SPEED = 1;
const OUTPUT_SAMPLE_RATE = 24000;

type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
type KokoroDevice = "wasm" | "webgpu" | "cpu" | null;
type KokoroVoice = string;

interface KokoroRawAudio {
  audio: Float32Array;
  sampling_rate: number;
}

interface KokoroTTSInstance {
  voices: Record<string, unknown>;
  generate(text: string, options: { voice: string; speed: number }): Promise<KokoroRawAudio>;
}

interface KokoroTTSConstructor {
  from_pretrained(
    modelId: string,
    options: {
      dtype: KokoroDtype;
      device: KokoroDevice;
      progress_callback?: (progress: { status?: string; progress?: number }) => void;
    }
  ): Promise<KokoroTTSInstance>;
}

const { KokoroTTS } = require("kokoro-js") as { KokoroTTS: KokoroTTSConstructor };

export class KokoroProvider implements TTSProvider {
  private tts: KokoroTTSInstance | null = null;
  private audioCallback?: (audio: string) => void;
  private errorCallback?: (error: Error) => void;
  private buffer = "";
  private synthesisQueue = Promise.resolve();
  private isShutdown = false;
  private voice = DEFAULT_VOICE as KokoroVoice;
  private speed = DEFAULT_SPEED;

  async initialize(options: TTSProviderInitializeOptions = {}) {
    const modelId = process.env.KOKORO_MODEL_ID || DEFAULT_MODEL_ID;
    const dtype = parseDtype(process.env.KOKORO_DTYPE);
    const device = parseDevice(process.env.KOKORO_DEVICE);

    this.voice = (process.env.KOKORO_VOICE || DEFAULT_VOICE) as KokoroVoice;
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

  streamText(text: string) {
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

  onAudio(callback: (audioBase64: string) => void) {
    this.audioCallback = callback;
  }

  onError(callback: (error: Error) => void) {
    this.errorCallback = callback;
  }

  shutdown() {
    this.isShutdown = true;
    this.buffer = "";
    this.tts = null;
  }

  private async synthesize(text: string) {
    if (!this.tts) {
      throw new Error("Kokoro provider is not initialized");
    }

    const audio = await this.tts.generate(text, {
      voice: this.voice,
      speed: this.speed,
    });
    const samples =
      audio.sampling_rate === OUTPUT_SAMPLE_RATE
        ? audio.audio
        : resampleLinear(audio.audio, audio.sampling_rate, OUTPUT_SAMPLE_RATE);
    const pcm = floatToPcm16Le(samples);

    if (!this.isShutdown) {
      this.audioCallback?.(pcm.toString("base64"));
    }
  }

  private reportError(error: Error) {
    if (!this.isShutdown) {
      this.errorCallback?.(error);
    }
  }
}

function parseDtype(value: string | undefined): KokoroDtype {
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

function parseDevice(value: string | undefined): KokoroDevice {
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

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received: ${value}`);
  }

  return parsed;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number) {
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

function floatToPcm16Le(samples: Float32Array) {
  const pcm = Buffer.allocUnsafe(samples.length * 2);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    pcm.writeInt16LE(Math.round(scaled), index * 2);
  }

  return pcm;
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
