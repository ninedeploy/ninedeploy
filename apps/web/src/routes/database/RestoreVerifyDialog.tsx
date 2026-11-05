import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Button, Field, Modal, Textarea } from '../../components/ui.js';

const ENGINE_NAME: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', valkey: 'Valkey', keydb: 'KeyDB', dragonfly: 'Dragonfly' };
const REDIS_FAMILY = new Set(['redis', 'valkey', 'keydb', 'dragonfly']);

/**
 * R3: start an isolated restore verification of one PostgreSQL, MySQL,
 * MariaDB or MongoDB backup. The panel restores it into a networkless helper, runs the
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
  // What the engine's own client prints decides how the expected value reads.
  const redisFamily = REDIS_FAMILY.has(engine);
  const queryHint =
    engine === 'mongo'
      ? t("One value is easiest, for example: db.getSiblingDB('shop').orders.countDocuments()")
      : redisFamily
        ? t('One command per line, for example: GET greeting')
        : t('One value is easiest, for example: SELECT count(*) FROM users');
  const expectedHint =
    engine === 'postgres'
      ? t('Exactly what psql prints, without headers. Separate rows with new lines; leave empty for no rows.')
      : engine === 'mongo'
        ? t('Exactly what mongosh prints for the last expression. EJSON.stringify(…) prints one stable line. The default database is test; address yours with db.getSiblingDB(…).')
        : redisFamily
          ? t('Exactly what the command-line client prints: one line per value or list element, an empty line for nil.')
          : t('Exactly what the client prints in batch mode, without headers: a tab between columns, one row per line, NULL as NULL. Unqualified table names resolve in the app database; leave empty for no rows.');
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
