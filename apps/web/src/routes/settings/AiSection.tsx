import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ANTHROPIC_DEFAULT_BASE_URL, ANTHROPIC_DEFAULT_MODEL, type AiProvider } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Skeleton } from '../../components/ui.js';

/**
 * AI (BYO-key): one provider + model + API key for the whole instance —
 * an OpenAI-compatible endpoint or (0.16.15) Claude through the Anthropic
 * API. Operator-only to change — the key is sent once and sealed
 * server-side; this form never receives it back.
 */
const OPENAI_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
export function AiSection() {
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [provider, setProvider] = useState<AiProvider>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => api.ai.getConfig(),
  });

  // 0.16.15: a panel that reports `provider` knows Claude; an older one only
  // speaks OpenAI-compatible, so the selector stays hidden there.
  const knowsProviders = config.data?.provider !== undefined;
  const anthropic = provider === 'anthropic';

  useEffect(() => {
    if (config.data) {
      const stored = config.data.provider ?? 'openai';
      setProvider(stored);
      const defaults = stored === 'anthropic' ? { baseUrl: '', model: ANTHROPIC_DEFAULT_MODEL } : OPENAI_DEFAULTS;
      setBaseUrl(stored === 'anthropic' && config.data.baseUrl === ANTHROPIC_DEFAULT_BASE_URL ? '' : (config.data.baseUrl ?? defaults.baseUrl));
      setModel(config.data.model ?? defaults.model);
    }
  }, [config.data]);

  // Switching provider swaps in that provider's defaults, so a Claude model
  // name is never sent to an OpenAI endpoint by accident.
  const chooseProvider = (next: AiProvider) => {
    setProvider(next);
    setBaseUrl(next === 'anthropic' ? '' : OPENAI_DEFAULTS.baseUrl);
    setModel(next === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULTS.model);
  };

  const save = useMutation({
    mutationFn: () => {
      const payload: { provider?: AiProvider; baseUrl?: string; model: string; apiKey?: string } = { model: model.trim() };
      if (knowsProviders) payload.provider = provider;
      if (baseUrl.trim()) payload.baseUrl = baseUrl.trim();
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      return api.ai.updateConfig(payload as Parameters<typeof api.ai.updateConfig>[0]);
    },
    onSuccess: () => {
      setApiKey('');
      // r342: the "configured" banner here and the deploy page's Diagnose
      // card both read ['ai-config'] — without this they stayed stale.
      qc.invalidateQueries({ queryKey: ['ai-config'] });
      toast('AI diagnosis settings saved', 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Failed to save', 'error'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Bot size={16} className="text-indigo-400" /> AI assistant
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Bring your own key: the panel asks Claude or an OpenAI-compatible endpoint to diagnose failed builds and to
          read a running service's logs. The sanitized tail of the log is sent to the provider — pick a provider you
          trust. It spends this key's budget, so only instance operators and members of a workspace an operator owns
          can use it.
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
              {knowsProviders && (
                <Field label="Provider" hint="Claude through the Anthropic API, or any OpenAI-compatible endpoint.">
                  <select
                    value={provider}
                    onChange={(e) => chooseProvider(e.target.value as AiProvider)}
                    aria-label="Provider"
                    disabled={!isOperator}
                    className="h-9 w-full rounded-lg bg-black/30 px-2 text-sm text-slate-100 ring-1 ring-inset ring-white/10"
                  >
                    <option value="anthropic">Claude (Anthropic)</option>
                    <option value="openai">OpenAI-compatible</option>
                  </select>
                </Field>
              )}
              <Field
                label="Base URL"
                hint={
                  anthropic
                    ? `Optional — leave empty for ${ANTHROPIC_DEFAULT_BASE_URL}, or name a gateway that speaks the Messages API.`
                    : 'OpenAI-compatible chat-completions endpoint (local Ollama/LM Studio works too).'
                }
              >
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={anthropic ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULTS.baseUrl}
                  aria-label="Base URL"
                  disabled={!isOperator}
                />
              </Field>
              <Field
                label="Model"
                hint={anthropic ? `e.g. ${ANTHROPIC_DEFAULT_MODEL}, claude-opus-5-5 or claude-haiku-5-5.` : 'As the provider expects it, e.g. gpt-4o-mini or llama3.1.'}
              >
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={anthropic ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULTS.model}
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
                  placeholder={config.data?.hasApiKey ? '•••••••• (stored)' : anthropic ? 'sk-ant-…' : 'sk-…'}
                  aria-label="API key"
                  disabled={!isOperator}
                  autoComplete="off"
                />
              </Field>
              {isOperator ? (
                <div className="flex items-center gap-2">
                  <Button onClick={() => save.mutate()} disabled={save.isPending || (!anthropic && !baseUrl.trim()) || !model.trim()}>
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
