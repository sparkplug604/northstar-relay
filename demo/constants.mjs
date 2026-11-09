import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const relayRoot = fileURLToPath(new URL('../relay/', import.meta.url));
export const agentRoot = fileURLToPath(new URL('../agent/', import.meta.url));
export const runtime = fileURLToPath(new URL('../runtime/', import.meta.url));
export const relayOrigin = 'http://127.0.0.1:3004';
export const nativeOrigin = 'http://127.0.0.1:3005';
export const ollamaOrigin = 'http://127.0.0.1:11435';
export const postgresPort = 55482;
export const dispatcherEmail = 'dispatch@relay-demo.invalid';
export const model = 'qwen3-relay:1.7b';
export const engine = 'ai-sdk:ollama';
