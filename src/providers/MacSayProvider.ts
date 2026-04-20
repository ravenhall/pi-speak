import { mkdtemp, readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { TTSProvider } from "../types.js";

export class MacSayProvider implements TTSProvider {
  private audioCallback?: (audio: string) => void;
  private buffer = "";
  private synthesisQueue = Promise.resolve();
  private isShutdown = false;
  private voice = process.env.MAC_SAY_VOICE;

  async initialize() {
    const pcm = await this.renderPcm("pi-speak");

    if (pcm.length === 0) {
      throw new Error("macOS say produced empty audio output");
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
        console.error("pi-speak: macOS say synthesis failed", error);
      });
  }

  onAudio(callback: (audioBase64: string) => void) {
    this.audioCallback = callback;
  }

  shutdown() {
    this.isShutdown = true;
    this.buffer = "";
  }

  private async synthesize(text: string) {
    const pcm = await this.renderPcm(text);

    if (!this.isShutdown) {
      this.audioCallback?.(pcm.toString("base64"));
    }
  }

  private extractWaveData(wav: Buffer) {
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("macOS say did not return a WAVE file");
    }

    let offset = 12;
    while (offset + 8 <= wav.length) {
      const chunkId = wav.toString("ascii", offset, offset + 4);
      const chunkSize = wav.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkSize;

      if (chunkId === "data") {
        return wav.subarray(chunkStart, chunkEnd);
      }

      offset = chunkEnd + (chunkSize % 2);
    }

    throw new Error("macOS say output did not contain a WAVE data chunk");
  }

  private runSay(args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("say", args);
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr || `say exited with code ${code}`));
      });
    });
  }

  private async renderPcm(text: string) {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-"));
    const outputPath = join(tempDir, "speech.wav");

    try {
      const args = [
        "-o",
        outputPath,
        "--file-format=WAVE",
        "--data-format=LEI16@24000",
        "--channels=1",
      ];

      if (this.voice) {
        args.push("-v", this.voice);
      }

      args.push(text);

      await this.runSay(args);

      const wav = await readFile(outputPath);
      return this.extractWaveData(wav);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
