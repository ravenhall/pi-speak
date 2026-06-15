"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureSpeechProvider = void 0;
const DEFAULT_AZURE_VOICE = "en-US-JennyNeural";
// TODO(azure-sso): Add first-class Microsoft Entra ID auth for this provider.
// Current behavior is subscription-key only:
// - initialize() requires AZURE_SPEECH_KEY plus AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT
// - synthesize() sends Ocp-Apim-Subscription-Key to the REST TTS endpoint
//
// The future Entra/SSO path should be implemented as a second auth mode, not as a breaking replacement.
// Use this plan:
//
// 1. Add explicit auth-mode selection.
//    Support something like:
//    - AZURE_SPEECH_AUTH_MODE=key
//    - AZURE_SPEECH_AUTH_MODE=entra
//    Default can remain key for backward compatibility until the new flow is proven.
//
// 2. Support non-secret Entra configuration.
//    For the Entra path, accept:
//    - AZURE_SPEECH_RESOURCE_ID: required for Speech auth token construction
//    - AZURE_SPEECH_ENDPOINT or AZURE_SPEECH_REGION: required to call the Speech REST endpoint
//    - optional AZURE_TENANT_ID / AZURE_CLIENT_ID only when a specific identity must be selected
//    Do not require AZURE_SPEECH_KEY in Entra mode.
//
// 3. Acquire a Microsoft Entra access token for Cognitive Services.
//    Use Azure Identity in Node (for example DefaultAzureCredential, or a narrower credential chain if
//    startup behavior needs tighter control). Request the scope:
//    - https://cognitiveservices.azure.com/.default
//    This allows seamless SSO in environments where the user is already signed in or where a managed
//    identity / workload identity is available.
//
// 4. Build the Speech authorization token in the format required by Azure Speech synthesis.
//    Microsoft documents that Speech synthesis with Entra auth uses:
//    - aad#{AZURE_SPEECH_RESOURCE_ID}#{AAD_ACCESS_TOKEN}
//    That composite value is then used as the bearer token value.
//    In practice the request header should become:
//    - Authorization: Bearer aad#{resourceId}#{aadToken}
//    and Ocp-Apim-Subscription-Key must not be sent in the same request.
//
// 5. Token caching and refresh.
//    Entra access tokens expire. Cache the composite bearer value and refresh it before expiry instead
//    of fetching a new token for every flush(). Keep the refresh logic inside the provider so callers do
//    not manage token lifetime. Refresh conservatively (for example a few minutes before expiry, or on
//    first use after expiry) and retry once on 401 if the token might have expired mid-flight.
//
// 6. Resource prerequisites and validation.
//    Entra auth for Speech requires the Azure Speech resource to be configured for Microsoft Entra
//    authentication, which Microsoft documents as including:
//    - a custom domain/subdomain for the Speech resource
//    - an appropriate role assignment such as Cognitive Services Speech User or Speech Contributor
//    initialize() should fail with an actionable error if Entra mode is selected but required env vars
//    are missing. The error text should also mention likely Azure-side prerequisites when auth fails.
//
// 7. Endpoint handling.
//    Preserve the current endpoint override behavior. When only region is provided, keep constructing:
//    - https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
//    If Azure later requires the custom-domain endpoint for this exact REST flow, prefer the explicit
//    endpoint env var and document that it should be the custom-domain endpoint.
//
// 8. Local-dev SSO behavior.
//    The intended "seamless SSO" developer experience is:
//    - developer signs in with Azure CLI / VS Code / managed identity-backed environment
//    - Azure Identity resolves credentials automatically
//    - pi-speak can synthesize without storing AZURE_SPEECH_KEY
//    If using DefaultAzureCredential, document its resolution order and provide an env var escape hatch
//    if a narrower credential choice becomes necessary.
//
// 9. Security constraints.
//    Never log raw Entra access tokens, the composite Speech bearer token, or subscription keys.
//    Keep Entra-mode logs limited to auth mode, endpoint, credential source hints, and sanitized errors.
//
// 10. Testing plan.
//    Add tests for:
//    - key mode still sending Ocp-Apim-Subscription-Key
//    - Entra mode sending Authorization: Bearer aad#...
//    - missing AZURE_SPEECH_RESOURCE_ID in Entra mode
//    - cached token reuse
//    - token refresh on expiry / 401
//    - fallback behavior when Entra auth initialization fails
//    Integration coverage should use a mocked token provider and mocked fetch; real Azure validation can
//    remain manual because it depends on tenant/resource configuration.
//
// Microsoft references used for this TODO:
// - Speech REST TTS auth supports either Ocp-Apim-Subscription-Key or Authorization: Bearer
// - Entra token scope: https://cognitiveservices.azure.com/.default
// - Speech synthesizer Entra token format: aad#{resourceId}#{aadToken}
// - Entra prerequisites include custom domain and Speech role assignment
class AzureSpeechProvider {
    audioCallback;
    errorCallback;
    buffer = "";
    synthesisQueue = Promise.resolve();
    isShutdown = false;
    endpoint = "";
    apiKey = "";
    voice = DEFAULT_AZURE_VOICE;
    async initialize() {
        const apiKey = process.env.AZURE_SPEECH_KEY;
        const region = process.env.AZURE_SPEECH_REGION;
        const endpoint = process.env.AZURE_SPEECH_ENDPOINT;
        if (!apiKey) {
            throw new Error("AZURE_SPEECH_KEY is required");
        }
        if (!endpoint && !region) {
            throw new Error("AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT is required");
        }
        this.apiKey = apiKey;
        this.voice = process.env.AZURE_SPEECH_VOICE || DEFAULT_AZURE_VOICE;
        this.endpoint =
            endpoint || `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
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
            console.error("pi-speak: Azure speech synthesis failed", error);
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
        const response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/ssml+xml",
                "Ocp-Apim-Subscription-Key": this.apiKey,
                "User-Agent": "pi-speak",
                "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
            },
            body: this.buildSsml(text),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure Speech HTTP ${response.status}: ${errorText}`);
        }
        const audio = Buffer.from(await response.arrayBuffer()).toString("base64");
        if (!this.isShutdown) {
            this.audioCallback?.(audio);
        }
    }
    buildSsml(text) {
        return [
            '<speak version="1.0" xml:lang="en-US">',
            `<voice name="${this.escapeXml(this.voice)}">`,
            this.escapeXml(text),
            "</voice>",
            "</speak>",
        ].join("");
    }
    escapeXml(value) {
        return value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");
    }
}
exports.AzureSpeechProvider = AzureSpeechProvider;
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
