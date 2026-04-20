export interface TTSProvider {
  initialize(): Promise<void>;
  streamText(text: string): void;
  flush(): void;
  shutdown(): void;
  onAudio(callback: (audioBase64: string) => void): void;
}

export type TTSProviderName = "elevenlabs" | "azure" | "macsay";
