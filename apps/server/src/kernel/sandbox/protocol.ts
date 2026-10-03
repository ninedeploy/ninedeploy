export type MainToWorkerMessage =
  | { type: 'INIT'; payload: { pluginId: string; manifest?: Record<string, unknown>; code?: string } }
  | { type: 'EVENT'; payload: { event: string; data: unknown } }
  // r532: `callId` identifies ONE invocation; the reply echoes it so two
  // concurrent calls of the same tap can no longer answer each other.
  | { type: 'HOOK_CALL'; payload: { hookId: string; callId: string; hookName: string; initialPayload: unknown } }
  | { type: 'CONFIG_RESPONSE'; payload: { reqId: string; value?: unknown; error?: string } }
  | { type: 'SHUTDOWN' };

export type WorkerToMainMessage =
  | { type: 'READY'; payload: { menuItems?: any[]; configSchema?: any[]; dependencies?: string[] } }
  | { type: 'LOG'; payload: { level: 'debug' | 'info' | 'warn' | 'error'; message: string } }
  | { type: 'EMIT_EVENT'; payload: { event: string; data?: unknown } }
  | { type: 'REGISTER_HOOK'; payload: { hookId: string; hookName: string; priority?: number } }
  | { type: 'HOOK_RESPONSE'; payload: { hookId: string; callId?: string; result?: unknown; error?: string } }
  | { type: 'CONFIG_GET'; payload: { reqId: string; key: string; defaultValue?: unknown; isSecret?: boolean } }
  | { type: 'CONFIG_SET'; payload: { key: string; value: unknown; options?: { isSecret?: boolean; description?: string; tags?: string[] } } }
  | { type: 'STATUS_CHANGED'; payload: { status: 'active' | 'disabled' | 'errored'; error?: string } }
  | { type: 'ERROR'; payload: { error: string; stack?: string } };
