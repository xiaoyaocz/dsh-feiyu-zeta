import type { Context } from '@deepseek-ai/cordis';

export interface ConversationBinding {
  key: string;
  appId: string;
  scope: 'c2c' | 'group';
  peerId: string;
  sessionId: string;
  title?: string;
}

export interface ConversationRecord {
  key: string;
  appId: string;
  scope: 'c2c' | 'group';
  peerId: string;
  target: string;
  title?: string;
  alias?: string;
  sessionId?: string;
  lastSeenAt: number;
  active: boolean;
  activeObservedAt?: number;
}

export interface SpeechProviderSettings {
  model: string;
  voice: string;
  speed: number;
  emotion?: string;
}

export interface SpeechSettings {
  enabled: boolean;
  provider: 'mimo' | 'minimax';
  mimo: SpeechProviderSettings;
  minimax: SpeechProviderSettings;
  maxTextCharacters: number;
  timeoutMs: number;
}

export interface ModuleExecution {
  agent?: unknown;
  signal: AbortSignal;
  callId?: string;
}

/** All module effects use the same trustworthy QQ route and sender. */
export interface ModuleHost {
  readonly ctx: Context;
  readonly dataDir: string;
  requireWritable?(): void;
  bindingFor(agent: unknown): ConversationBinding | undefined;
  /** Trusted actors share one library; optional for existing module adapters. */
  spaceFor?(agent: unknown): string;
  isLifeAgent(agent: unknown): boolean;
  directoryFor(agent: unknown, kind: 'speech' | 'memes'): Promise<string>;
  sendFile(agent: unknown, absolutePath: string, target: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
  sendText(agent: unknown, text: string, target: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
  resolveApiKey(provider: 'mimo' | 'minimax'): Promise<string>;
}

export interface RegisteredModule {
  dispose?(): void | Promise<void>;
}
