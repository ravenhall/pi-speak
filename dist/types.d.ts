export interface TTSProvider {
    initialize(): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    shutdown(): void;
    onAudio(callback: (audioBase64: string) => void): void;
    onError(callback: (error: Error) => void): void;
}
export type TTSProviderName = "elevenlabs" | "azure" | "kokoro" | "macsay";
