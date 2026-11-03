/**
 * Backup and restore.
 *
 * Restore is deliberately the most cautious action in the product: the selected
 * file is verified (SQLite integrity, schema compatibility, row counts), a
 * safety copy of the live database is taken, and only then is the swap applied
 * and the application restarted. The UI states each step rather than hiding it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  useUi,
} from '../components';
import { formatPaisa } from '../../core/foundation/money';

interface BackupLogRow {
  id: string;
  at: string;
  kind: string;
  path: string;
  size_bytes: number;
  sha256: string;
  status: string;
  note: string | null;
}

interface Verification {
  valid: boolean;
  path: string;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  appVersion: string | null;
  integrity: string;
  counts: Record<string, number>;
  errors: string[];
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function BackupScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const [rows, setRows] = useState<BackupLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [settingsState, setSettingsState] = useState<Record<string, string>>({});
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [backups, settings] = await Promise.all([
        call<BackupLogRow[]>('backup', 'list'),
        call<Record<string, string>>('settings', 'all'),
      ]);
      setRows(backups);
      setSettingsState(settings);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const createBackup = async () => {
    setBusy(true);
    try {
      const result = await call<{ canceled?: boolean; backup?: { path: string; sizeBytes: number } }>(
        'backup',
        'create',
        {},
      );
      if (result.canceled) return;
      toast(
        'success',
        lang === 'bn'
          ? `ব্যাকআপ সংরক্ষিত · ${humanBytes(result.backup?.sizeBytes ?? 0)}`
          : `Backup saved · ${humanBytes(result.backup?.sizeBytes ?? 0)}`,
      );
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const result = await call<{ canceled?: boolean; verification?: Verification }>('backup', 'verify', {});
      if (result.canceled || !result.verification) return;
      setVerification(result.verification);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pickRestore = async () => {
    try {
      const result = await call<{ canceled?: boolean; selectedPath?: string }>('backup', 'restore');
      if (result.canceled || !result.selectedPath) return;
      setPendingRestore(result.selectedPath);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const applyRestore = async () => {
    if (!pendingRestore) return;
    setBusy(true);
    try {
      await call('backup', 'applyRestore', { backupPath: pendingRestore });
      // The main process relaunches; nothing after this should normally run.
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
      setBusy(false);
      setPendingRestore(null);
    }
  };

  const prune = async () => {
    const directory = settingsState['backup.location'];
    if (!directory) {
      toast('warning', lang === 'bn' ? 'সেটিংসে ব্যাকআপ ফোল্ডার নির্ধারণ করুন।' : 'Set a backup folder in Settings first.');
      return;
    }
    try {
      const result = await call<{ removed: string[] }>('backup', 'prune', { directory });
      toast('success', `${result.removed.length} ${lang === 'bn' ? 'পুরনো ফাইল মুছে ফেলা হয়েছে' : 'old files removed'}`);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('navBackup')}
        subtitle={
          lang === 'bn'
            ? 'ডাটাবেসের নিরাপদ কপি, যাচাই ও পুনরুদ্ধার'
            : 'Safe database copies, verification and restore'
        }
        actions={
          <>
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button onClick={() => void verify()} loading={busy}>
              {t('verifyBackup')}
            </Button>
            <Button variant="primary" onClick={() => void createBackup()} loading={busy}>
              {t('backupNow')}
            </Button>
          </>
        }
      />

      <div className="stack">
        <Card title={lang === 'bn' ? 'ব্যাকআপ নীতি' : 'Backup policy'} bodyClass="tight">
          <div className="summary-strip" style={{ border: 0, background: 'transparent' }}>
            <div className="item">
              <div className="label">{lang === 'bn' ? 'স্বয়ংক্রিয় ব্যাকআপ' : 'Automatic backup'}</div>
              <div className="value">{settingsState['backup.auto_enabled'] === 'true' ? (lang === 'bn' ? 'চালু' : 'On') : lang === 'bn' ? 'বন্ধ' : 'Off'}</div>
            </div>
            <div className="item">
              <div className="label">{lang === 'bn' ? 'ফ্রিকোয়েন্সি' : 'Frequency'}</div>
              <div className="value">{settingsState['backup.frequency'] ?? 'daily'}</div>
            </div>
            <div className="item">
              <div className="label">{lang === 'bn' ? 'সংরক্ষণ সংখ্যা' : 'Retention'}</div>
              <div className="value">{settingsState['backup.retention_count'] ?? '14'}</div>
            </div>
            <div className="item">
              <div className="label">{lang === 'bn' ? 'ফোল্ডার' : 'Folder'}</div>
              <div className="value truncate" style={{ maxWidth: 360 }} title={settingsState['backup.location'] ?? ''}>
                {settingsState['backup.location'] || '—'}
              </div>
            </div>
          </div>
          <div className="row" style={{ padding: 12, gap: 8 }}>
            <Button size="sm" onClick={() => void prune()}>
              {lang === 'bn' ? 'পুরনো ব্যাকআপ পরিষ্কার' : 'Prune old backups'}
            </Button>
            <Button size="sm" variant="warning" onClick={() => void pickRestore()}>
              {t('restoreBackup')}
            </Button>
          </div>
        </Card>

        <Card title={lang === 'bn' ? 'ব্যাকআপ ইতিহাস' : 'Backup history'} bodyClass="tight">
          {loading ? (
            <Spinner />
          ) : (
            <DataTable
              rows={rows}
              keyOf={(r) => r.id}
              empty={
                <EmptyState
                  title={lang === 'bn' ? 'এখনও কোনো ব্যাকআপ নেই' : 'No backups yet'}
                  hint={lang === 'bn' ? '"এখনই ব্যাকআপ নিন" চাপুন।' : 'Press "Back up now" to create the first one.'}
                  action={
                    <Button variant="primary" size="sm" onClick={() => void createBackup()}>
                      {t('backupNow')}
                    </Button>
                  }
                />
              }
              columns={[
                { key: 'at', header: t('date'), render: (r) => <span className="small">{r.at.replace('T', ' ').slice(0, 19)}</span> },
                {
                  key: 'kind',
                  header: lang === 'bn' ? 'ধরন' : 'Kind',
                  render: (r) => <Badge tone={r.kind === 'manual' ? 'brand' : 'default'}>{r.kind}</Badge>,
                },
                {
                  key: 'path',
                  header: lang === 'bn' ? 'ফাইল' : 'File',
                  render: (r) => (
                    <span className="truncate mono small" title={r.path}>
                      {r.path.split(/[\\/]/).pop()}
                    </span>
                  ),
                },
                { key: 'size', header: lang === 'bn' ? 'আকার' : 'Size', align: 'right', render: (r) => <span className="mono small">{humanBytes(r.size_bytes)}</span> },
                {
                  key: 'sha',
                  header: 'SHA-256',
                  render: (r) => <span className="mono small" title={r.sha256}>{r.sha256.slice(0, 12)}…</span>,
                },
                {
                  key: 'status',
                  header: t('status'),
                  render: (r) =>
                    r.status === 'success' ? (
                      <Badge tone="success">{lang === 'bn' ? 'ঠিক আছে' : 'OK'}</Badge>
                    ) : (
                      <Badge tone="danger">{lang === 'bn' ? 'ব্যর্থ' : 'Failed'}</Badge>
                    ),
                },
              ]}
            />
          )}
        </Card>

        <Alert tone="warning">
          {lang === 'bn'
            ? 'পুনরুদ্ধার করলে বর্তমান ডাটাবেস প্রতিস্থাপিত হবে এবং অ্যাপ্লিকেশন পুনরায় চালু হবে। আগে একটি নিরাপত্তা কপি স্বয়ংক্রিয়ভাবে তৈরি হবে।'
            : 'Restoring replaces the current database and restarts the application. A safety copy of the current database is taken first.'}
        </Alert>
      </div>

      {verification ? (
        <Modal
          title={t('verifyBackup')}
          onClose={() => setVerification(null)}
          footer={<Button onClick={() => setVerification(null)}>{t('close')}</Button>}
        >
          <div className="stack">
            <Alert tone={verification.valid ? 'success' : 'danger'}>
              {verification.valid
                ? lang === 'bn'
                  ? 'ব্যাকআপ ফাইলটি বৈধ এবং পুনরুদ্ধারের জন্য প্রস্তুত।'
                  : 'This backup is valid and ready to restore.'
                : lang === 'bn'
                  ? 'ব্যাকআপ ফাইলটি বৈধ নয়।'
                  : 'This backup is not valid.'}
            </Alert>
            <div className="summary-strip">
              <div className="item">
                <div className="label">{lang === 'bn' ? 'ইন্টিগ্রিটি' : 'Integrity'}</div>
                <div className="value">{verification.integrity}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'স্কিমা' : 'Schema'}</div>
                <div className="value">v{verification.schemaVersion}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'আকার' : 'Size'}</div>
                <div className="value">{humanBytes(verification.sizeBytes)}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'অ্যাপ সংস্করণ' : 'App version'}</div>
                <div className="value">{verification.appVersion ?? '—'}</div>
              </div>
            </div>
            {Object.keys(verification.counts).length > 0 ? (
              <div className="card" style={{ padding: 12 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  {lang === 'bn' ? 'রেকর্ড সংখ্যা' : 'Record counts'}
                </div>
                <div className="row wrap" style={{ gap: 12 }}>
                  {Object.entries(verification.counts).map(([table, count]) => (
                    <span key={table} className="small">
                      <strong>{table}</strong>: {count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {verification.errors.length > 0 ? (
              <ul className="small text-danger">
                {verification.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
            <div className="small muted" title={verification.path}>
              {verification.path}
            </div>
          </div>
        </Modal>
      ) : null}

      {pendingRestore ? (
        <Modal
          title={t('restoreBackup')}
          onClose={() => {
            setPendingRestore(null);
            setConfirmName('');
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setPendingRestore(null);
                  setConfirmName('');
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void applyRestore()}
                disabled={confirmName.trim() !== (pendingRestore.split(/[\\/]/).pop() ?? '')}
              >
                {lang === 'bn' ? 'পুনরুদ্ধার করুন' : 'Restore'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="warning">
              {lang === 'bn'
                ? 'বর্তমান ডাটাবেসের একটি নিরাপত্তা কপি নিয়ে নির্বাচিত ব্যাকআপটি পুনরুদ্ধার করা হবে। এরপর অ্যাপ্লিকেশন বন্ধ হয়ে আবার চালু হবে।'
                : 'The selected backup will replace the current database after a safety copy is taken. MERQO will then close and restart.'}
            </Alert>
            <div className="mono small">{pendingRestore}</div>
            <Field
              label={
                lang === 'bn'
                  ? 'নিশ্চিত করতে ফাইলের নাম হুবহু লিখুন'
                  : 'Type the file name exactly to confirm'
              }
              required
            >
              <Input
                autoFocus
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={pendingRestore.split(/[\\/]/).pop() ?? ''}
              />
            </Field>
            <div className="small muted">
              {lang === 'bn' ? 'বর্তমান ডাটাবেস: ' : 'Current database: '}
              <span className="mono">{settingsState['business.name'] ?? ''}</span>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/** Kept so the module has a stable helper for future reporting of sizes. */
export const backupHelpers = { humanBytes, formatPaisa };
