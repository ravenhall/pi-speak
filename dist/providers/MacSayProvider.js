"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MacSayProvider = void 0;
const promises_1 = require("fs/promises");
const child_process_1 = require("child_process");
const path_1 = require("path");
const os_1 = require("os");
class MacSayProvider {
    audioCallback;
    errorCallback;
    buffer = "";
    synthesisQueue = Promise.resolve();
    isShutdown = false;
    voice = process.env.MAC_SAY_VOICE;
    async initialize() {
        const pcm = await this.renderPcm("pi-speak");
        if (pcm.length === 0) {
            throw new Error("macOS say produced empty audio output");
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
            console.error("pi-speak: macOS say synthesis failed", error);
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
    }
    reportError(error) {
        if (!this.isShutdown) {
            this.errorCallback?.(error);
        }
    }
    async synthesize(text) {
        const pcm = await this.renderPcm(text);
        if (!this.isShutdown) {
            this.audioCallback?.(pcm.toString("base64"));
        }
    }
    extractWaveData(wav) {
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
    runSay(args) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)("say", args);
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
    async renderPcm(text) {
        const tempDir = await (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), "pi-speak-"));
        const outputPath = (0, path_1.join)(tempDir, "speech.wav");
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
            const wav = await (0, promises_1.readFile)(outputPath);
            return this.extractWaveData(wav);
        }
        finally {
            await (0, promises_1.rm)(tempDir, { recursive: true, force: true });
        }
    }
}
exports.MacSayProvider = MacSayProvider;
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
