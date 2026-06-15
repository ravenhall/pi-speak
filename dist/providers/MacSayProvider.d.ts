import { TTSProvider } from "../types.js";
export declare class MacSayProvider implements TTSProvider {
    private audioCallback?;
    private errorCallback?;
    private buffer;
    private synthesisQueue;
    private isShutdown;
    private voice;
    initialize(): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    onAudio(callback: (audioBase64: string) => void): void;
    onError(callback: (error: Error) => void): void;
    shutdown(): void;
    private reportError;
    private synthesize;
    private extractWaveData;
    private runSay;
    private renderPcm;
}
