export interface TTSProvider {
    initialize(options?: TTSProviderInitializeOptions): Promise<void>;
    streamText(text: string): void;
    flush(): void;
    shutdown(): void;
    onAudio(callback: (audioBase64: string) => void): void;
    onError(callback: (error: Error) => void): void;
}
export interface TTSProviderInitializeOptions {
    onProgress?: (progress: TTSProviderProgress) => void;
}
export interface TTSProviderProgress {
    provider: TTSProviderName;
    message: string;
    percent?: number;
}
export type TTSProviderName = "elevenlabs" | "azure" | "kokoro" | "macsay";
