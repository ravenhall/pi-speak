import { TTSProvider } from "../types.js";
export declare class AzureSpeechProvider implements TTSProvider {
    private audioCallback?;
    private errorCallback?;
    private buffer;
    private synthesisQueue;
    private isShutdown;
    private endpoint;
    private apiKey;
    private voice;
    initialize(): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    onAudio(callback: (audioBase64: string) => void): void;
    onError(callback: (error: Error) => void): void;
    shutdown(): void;
    private reportError;
    private synthesize;
    private buildSsml;
    private escapeXml;
}
