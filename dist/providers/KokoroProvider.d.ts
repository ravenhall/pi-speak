import { TTSProvider, TTSProviderInitializeOptions } from "../types.js";
export declare class KokoroProvider implements TTSProvider {
    private tts;
    private audioCallback?;
    private errorCallback?;
    private buffer;
    private synthesisQueue;
    private isShutdown;
    private voice;
    private speed;
    initialize(options?: TTSProviderInitializeOptions): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    onAudio(callback: (audioBase64: string) => void): void;
    onError(callback: (error: Error) => void): void;
    shutdown(): void;
    private synthesize;
    private reportError;
}
