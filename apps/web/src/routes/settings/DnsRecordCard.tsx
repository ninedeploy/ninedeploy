import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Field, Input } from '../../components/ui.js';

/**
 * Settings → Integrations (G1.5 domain presets): create the DNS record for a
 * hostname through the configured DNS provider, the way adding a domain does
 * on its own. The content defaults to the configured record content, else
 * the panel's public IP. Admins only on the server.
 */
export function DnsRecordCard() {
  const t = useT();
  const { toast } = useToast();
  const providers = useQuery({ queryKey: ['domain-presets'], queryFn: () => api.domainPresets.list(), retry: false });
  const [hostname, setHostname] = useState('');
  const [content, setContent] = useState('');
  const create = useMutation({
    mutationFn: () => api.domainPresets.apply({ hostname: hostname.trim(), ...(content.trim() ? { content: content.trim() } : {}) }),
    onSuccess: (r) => {
      toast(t('{type} record for {host} created in {zone} ({content})', { type: r.type, host: r.hostname, zone: r.zone, content: r.content }), 'success');
      setHostname('');
      setContent('');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!providers.data?.providers.length) return null;

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <PlusCircle size={15} className="text-slate-500" /> {t('Create a DNS record')}
        </div>
        <p className="text-xs text-slate-500">
          {t('Creates an A, AAAA or CNAME record through the DNS provider set above, in the zone that holds the hostname. Leave the content empty to use the configured record content, else the public IP of the panel.')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Hostname')}>
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" />
          </Field>
          <Field label={t('Content (optional)')}>
            <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="203.0.113.10" />
          </Field>
        </div>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending || hostname.trim().length < 3}>
          {create.isPending ? t('Creating…') : t('Create record')}
        </Button>
      </CardBody>
    </Card>
  );
}
