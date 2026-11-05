import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Button, Field, Modal, Textarea } from '../../components/ui.js';

const ENGINE_NAME: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', valkey: 'Valkey', keydb: 'KeyDB', dragonfly: 'Dragonfly', clickhouse: 'ClickHouse', meilisearch: 'Meilisearch', rabbitmq: 'RabbitMQ' };
const REDIS_FAMILY = new Set(['redis', 'valkey', 'keydb', 'dragonfly']);

/** What the engine's own client takes and prints decides how the query and the expected value read. */
function probeHints(t: ReturnType<typeof useT>, engine: string): { queryHint: string; expectedHint: string } {
  const sqlQuery = t('One value is easiest, for example: SELECT count(*) FROM users');
  if (REDIS_FAMILY.has(engine)) {
    return {
      queryHint: t('One command per line, for example: GET greeting'),
      expectedHint: t('Exactly what the command-line client prints: one line per value or list element, an empty line for nil.'),
    };
  }
  switch (engine) {
    case 'postgres':
      return { queryHint: sqlQuery, expectedHint: t('Exactly what psql prints, without headers. Separate rows with new lines; leave empty for no rows.') };
    case 'mongo':
      return {
        queryHint: t("One value is easiest, for example: db.getSiblingDB('shop').orders.countDocuments()"),
        expectedHint: t('Exactly what mongosh prints for the last expression. EJSON.stringify(…) prints one stable line. The default database is test; address yours with db.getSiblingDB(…).'),
      };
    case 'clickhouse':
      return { queryHint: sqlQuery, expectedHint: t('Exactly what clickhouse-client prints (TabSeparated): a tab between columns, one row per line, NULL as \\N. Unqualified table names resolve in the app database; leave empty for no rows.') };
    case 'meilisearch':
      return {
        queryHint: t('An API path, for example: /indexes/movies/documents/1?fields=title'),
        expectedHint: t('Exactly the JSON body a GET on that path returns. Search results carry a processing time, so prefer documents and stats.'),
      };
    case 'rabbitmq':
      return {
        queryHint: t('One rabbitmqctl list command, for example: list_queues -p shop name durable'),
        expectedHint: t('Exactly what rabbitmqctl prints without headers: a tab between columns, one row per line, in any order. A definitions backup holds no messages, so list names and settings, not message counts.'),
      };
    default:
      return { queryHint: sqlQuery, expectedHint: t('Exactly what the client prints in batch mode, without headers: a tab between columns, one row per line, NULL as NULL. Unqualified table names resolve in the app database; leave empty for no rows.') };
  }
}

/**
 * R3: start an isolated restore verification of one backup in its own
 * engine image. The panel restores it into a networkless helper, runs the
 * operator's query there and compares the output with the expected value. It
 * answers at once (the verdict lands on the drill row the backups table
 * polls), so this dialog closes as soon as the verification is admitted.
 */
export function RestoreVerifyDialog({ dbId, backupId, engine, onClose }: { dbId: number; backupId: number; engine: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [expected, setExpected] = useState('');
  const { queryHint, expectedHint } = probeHints(t, engine);
  const start = useMutation({
    mutationFn: () => api.databases.drillBackup(dbId, { backupId, restore: { query, expected } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['database-drills', dbId] });
      toast(t('Restore verification started'), 'success');
      onClose();
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Restore verification could not start'), 'error'),
  });
  return (
    <Modal
      title={t('Verify restore of backup #{id}', { id: backupId })}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" type="submit" form="restore-verify-form" disabled={start.isPending || !query.trim()}>
            {start.isPending ? t('Starting…') : t('Start verification')}
          </Button>
        </div>
      }
    >
      <form
        id="restore-verify-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) start.mutate();
        }}
      >
        <p className="text-sm text-slate-400">
          {t('The backup is restored into an isolated {engine} container on the panel host, with no network. Your query runs there, and the check passes only when its output equals the expected value exactly. The live database is not touched; the query and the value are not stored.', { engine: ENGINE_NAME[engine] ?? engine })}
        </p>
        <Field label={t('Query')} hint={queryHint}>
          <Textarea
            required
            rows={3}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="font-mono text-xs"
            maxLength={16384}
          />
        </Field>
        <Field label={t('Expected output')} hint={expectedHint}>
          <Textarea
            rows={2}
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            className="font-mono text-xs"
            maxLength={16384}
          />
        </Field>
      </form>
    </Modal>
  );
}
