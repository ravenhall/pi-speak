import { TTSProvider } from "../types.js";
export declare class ElevenLabsProvider implements TTSProvider {
    private socket;
    private openingSocket;
    private audioCallback?;
    private errorCallback?;
    private isShutdown;
    private apiKey;
    private streamUrl;
    private pendingText;
    private pendingFlush;
    private expectedClose;
    initialize(): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    onAudio(callback: (audio: string) => void): void;
    onError(callback: (error: Error) => void): void;
    shutdown(): void;
    private ensureSocket;
    private drainPendingInput;
    private reportError;
    private parseMessage;
}
