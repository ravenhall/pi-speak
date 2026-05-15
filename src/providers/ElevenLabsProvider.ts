import WebSocket, { RawData } from "ws";
import { TTSProvider } from "../types.js";

interface ElevenLabsStreamMessage {
  audio?: string;
  isFinal?: boolean;
}

export class ElevenLabsProvider implements TTSProvider {
  private socket: WebSocket | null = null;
  private audioCallback?: (audio: string) => void;
  private errorCallback?: (error: Error) => void;
  private isShutdown = false;

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
    const socket = new WebSocket(url);

    socket.on("message", (data) => {
      const message = this.parseMessage(data);
      if (message?.audio) {
        this.audioCallback?.(message.audio);
      }
    });

    socket.on("error", (error) => {
      console.error("pi-speak: ElevenLabs WebSocket error", error);
      this.reportError(error);
    });

    socket.on("close", (code, reason) => {
      if (this.isShutdown || code === 1000) {
        return;
      }

      const error = new Error(
        `ElevenLabs WebSocket closed unexpectedly (${code}) ${reason.toString()}`
      );
      console.error(`pi-speak: ${error.message}`);
      this.reportError(error);
    });

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        socket.send(
          JSON.stringify({
            text: " ",
            xi_api_key: apiKey,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
            },
          })
        );
        resolve();
      };

      const handleError = (error: Error) => {
        reject(error);
      };

      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });

    this.socket = socket;
  }

  streamText(text: string) {
    if (!text || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        text,
        try_trigger_generation: true,
      }),
      (error) => {
        if (error) {
          this.reportError(error);
        }
      }
    );
  }

  flush() {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        text: "",
        flush: true,
      }),
      (error) => {
        if (error) {
          this.reportError(error);
        }
      }
    );
  }

  onAudio(callback: (audio: string) => void) {
    this.audioCallback = callback;
  }

  onError(callback: (error: Error) => void) {
    this.errorCallback = callback;
  }

  shutdown() {
    this.isShutdown = true;
    this.socket?.close();
    this.socket = null;
  }

  private reportError(error: Error) {
    if (!this.isShutdown) {
      this.errorCallback?.(error);
    }
  }

  private parseMessage(data: RawData): ElevenLabsStreamMessage | null {
    try {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");

      return JSON.parse(raw) as ElevenLabsStreamMessage;
    } catch (error) {
      console.error("pi-speak: Failed to parse ElevenLabs message", error);
      return null;
    }
  }
}
