import { TTSProvider } from "../types.js";
export declare class ElevenLabsProvider implements TTSProvider {
    private socket;
    private audioCallback?;
    private errorCallback?;
    private isShutdown;
    initialize(): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    onAudio(callback: (audio: string) => void): void;
    onError(callback: (error: Error) => void): void;
    shutdown(): void;
    private reportError;
    private parseMessage;
}
