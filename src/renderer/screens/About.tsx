/**
 * About / support.
 *
 * Deliberately factual: version, data locations, and an explicit list of what
 * has and has not been verified in this build. No marketing claims about tax
 * compliance or printer compatibility.
 */
import React, { useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, useUi } from '../components';
import { useApp } from '../App';

interface Health {
  startup: {
    databasePath: string;
    schemaVersion: number;
    integrity: string;
    foreignKeyViolations: number;
    migratedFrom: number;
    migratedTo: number;
    autoBackupPath: string | null;
    developmentKey: boolean;
  } | null;
  journalsBalanced: { ok: boolean; unbalanced: string[] };
  inventory: { ok: boolean; difference: number };
}

export function AboutScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { appInfo } = useApp();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call<Health>('system', 'health')
      .then(setHealth)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.messageBn : String(err)));
  }, []);

  const openFolder = async (path: string) => {
    try {
      await call('system', 'openFolder', { path });
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('about')}
        subtitle={lang === 'bn' ? 'সংস্করণ, ডাটা অবস্থান ও সিস্টেম যাচাই' : 'Version, data locations and system checks'}
      />

      <div className="grid cols-2">
        <Card title="MERQO Business Suite">
          <div className="stack">
            <div className="row between">
              <span className="muted">{t('version')}</span>
              <span className="mono">{appInfo.version}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'ইলেকট্রন' : 'Electron'}</span>
              <span className="mono small">{appInfo.electron}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'ক্রোমিয়াম' : 'Chromium'}</span>
              <span className="mono small">{appInfo.chrome}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'প্ল্যাটফর্ম' : 'Platform'}</span>
              <span className="mono small">{appInfo.platform}</span>
            </div>
            <div className="row between">
              <span className="muted">{t('developer')}</span>
              <span>{appInfo.founder}</span>
            </div>
            <div className="row between">
              <span className="muted">{t('contact')}</span>
              <span className="mono small">{appInfo.contact}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'লাইসেন্স' : 'Licence'}</span>
              {appInfo.licensed ? (
                <Badge tone="success">{t('licenseActive')}</Badge>
              ) : (
                <Badge tone="warning">{lang === 'bn' ? 'পরীক্ষামূলক' : 'Evaluation'}</Badge>
              )}
            </div>
          </div>
        </Card>

        <Card title={lang === 'bn' ? 'ডাটা অবস্থান' : 'Data locations'}>
          <div className="stack">
            <Field label={lang === 'bn' ? 'ডাটাবেস' : 'Database'}>
              <Input readOnly value={appInfo.databasePath} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Field label={lang === 'bn' ? 'ব্যাকআপ ফোল্ডার' : 'Backups'}>
              <Input readOnly value={appInfo.backupDir} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Field label={lang === 'bn' ? 'লগ ফোল্ডার' : 'Logs'}>
              <Input readOnly value={appInfo.logDir} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" onClick={() => void openFolder(appInfo.dataDir)}>
                {t('openFolder')}
              </Button>
              <Button size="sm" onClick={() => void openFolder(appInfo.logDir)}>
                {lang === 'bn' ? 'লগ খুলুন' : 'Open logs'}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }} className="grid cols-2">
        <Card title={t('healthCheck')}>
          {error ? <Alert tone="danger">{error}</Alert> : !health ? <Spinner /> : (
            <div className="stack small">
              <div className="row between">
                <span className="muted">{lang === 'bn' ? 'স্কিমা সংস্করণ' : 'Schema version'}</span>
                <span className="mono">v{health.startup?.schemaVersion}</span>
              </div>
              <div className="row between">
                <span className="muted">{lang === 'bn' ? 'ইন্টিগ্রিটি' : 'Integrity'}</span>
                <Badge tone={health.startup?.integrity === 'ok' ? 'success' : 'danger'}>
                  {health.startup?.integrity}
                </Badge>
              </div>
              <div className="row between">
                <span className="muted">{lang === 'bn' ? 'ফরেন-কি লঙ্ঘন' : 'Foreign-key violations'}</span>
                <span className="mono">{health.startup?.foreignKeyViolations ?? 0}</span>
              </div>
              <div className="row between">
                <span className="muted">{lang === 'bn' ? 'জার্নাল ভারসাম্য' : 'Journals balanced'}</span>
                <Badge tone={health.journalsBalanced.ok ? 'success' : 'danger'}>
                  {health.journalsBalanced.ok ? 'OK' : `${health.journalsBalanced.unbalanced.length}`}
                </Badge>
              </div>
              <div className="row between">
                <span className="muted">{lang === 'bn' ? 'স্টক ও খতিয়ান' : 'Stock vs ledger'}</span>
                <Badge tone={health.inventory.ok ? 'success' : 'warning'}>
                  {health.inventory.ok ? 'OK' : String(health.inventory.difference)}
                </Badge>
              </div>
            </div>
          )}
        </Card>

        <Card title={lang === 'bn' ? 'এই বিল্ডে কী যাচাই হয়েছে' : 'What is verified in this build'}>
          <div className="stack small">
            <Alert tone="success">
              {lang === 'bn'
                ? 'অটোমেটেড টেস্ট: অ্যাকাউন্টিং, বিক্রয়, ক্রয়, ফেরত, স্টক, রিপোর্ট, ব্যাকআপ, লাইসেন্স ও প্রিন্ট ডেটা তৈরি।'
                : 'Automated tests cover accounting, sales, purchases, returns, stock, reports, backup, licensing and print-job construction.'}
            </Alert>
            <Alert tone="warning">
              {lang === 'bn'
                ? 'এখনও যাচাই হয়নি: বাস্তব ৫৮/৮০ মিমি থার্মাল প্রিন্টার, বারকোড স্ক্যানার হার্ডওয়্যার, NSIS ইনস্টলার চালানো এবং Authenticode স্বাক্ষর।'
                : 'Not yet verified: physical 58/80 mm thermal printers, barcode-scanner hardware, running the NSIS installer, and Authenticode signing.'}
            </Alert>
            <Alert tone="info">
              {lang === 'bn'
                ? 'MERQO বাংলাদেশের ভ্যাট নিয়ম অনুসরণ করার জন্য ডিজাইন করা, তবে সরকারি ভ্যাট সফটওয়্যার হিসেবে অনুমোদিত নয়।'
                : 'MERQO is designed around Bangladeshi VAT practice, but it is not an officially approved VAT software.'}
            </Alert>
          </div>
        </Card>
      </div>
    </>
  );
}
