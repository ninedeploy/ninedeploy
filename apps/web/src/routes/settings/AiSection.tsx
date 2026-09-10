import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Skeleton } from '../../components/ui.js';

/**
 * AI failure diagnosis (BYO-key): one OpenAI-compatible endpoint + model +
 * API key for the whole instance. Operator-only to change — the key is sent
 * once and sealed server-side; this form never receives it back.
 */
export function AiSection() {
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const { toast } = useToast();

  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => api.ai.getConfig(),
  });

  useEffect(() => {
    if (config.data) {
      setBaseUrl(config.data.baseUrl ?? 'https://api.openai.com/v1');
      setModel(config.data.model ?? 'gpt-4o-mini');
    }
  }, [config.data]);

  const save = useMutation({
    mutationFn: () => {
      const payload: { baseUrl: string; model: string; apiKey?: string } = { baseUrl: baseUrl.trim(), model: model.trim() };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      return api.ai.updateConfig(payload);
    },
    onSuccess: () => {
      setApiKey('');
      toast('AI diagnosis settings saved', 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Failed to save', 'error'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Bot size={16} className="text-indigo-400" /> AI failure diagnosis
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Bring your own key: the panel asks an OpenAI-compatible chat-completions endpoint to diagnose failed build
          logs. The sanitized tail of the log is sent to the provider — pick a provider you trust.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {config.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div
                className={
                  config.data?.configured
                    ? 'rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300'
                    : 'rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300'
                }
              >
                {config.data?.configured
                  ? `Configured — ${config.data.model} via ${config.data.baseUrl}`
                  : 'Not configured — failed deploys offer no diagnosis button yet.'}
                {config.data?.hasApiKey && ' An API key is stored.'}
              </div>
              <Field label="Base URL" hint="OpenAI-compatible chat-completions endpoint (local Ollama/LM Studio works too).">
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  aria-label="Base URL"
                  disabled={!isOperator}
                />
              </Field>
              <Field label="Model" hint="As the provider expects it, e.g. gpt-4o-mini or llama3.1.">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  aria-label="Model"
                  disabled={!isOperator}
                />
              </Field>
              <Field
                label="API key"
                hint={
                  config.data?.hasApiKey
                    ? 'A key is stored. Leave empty to keep it — type to replace.'
                    : 'Stored encrypted at rest; never returned by the API.'
                }
              >
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config.data?.hasApiKey ? '•••••••• (stored)' : 'sk-…'}
                  aria-label="API key"
                  disabled={!isOperator}
                  autoComplete="off"
                />
              </Field>
              {isOperator ? (
                <div className="flex items-center gap-2">
                  <Button onClick={() => save.mutate()} disabled={save.isPending || !baseUrl.trim() || !model.trim()}>
                    {save.isPending ? 'Saving…' : 'Save AI settings'}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Only the instance operator can change these settings.</p>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
