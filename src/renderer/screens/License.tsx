/**
 * Licence activation.
 *
 * MERQO is sold offline: the customer receives a signed `.merqo` licence file
 * bound to this machine's device ID. Nothing here contacts a server, and the
 * private signing key never exists inside the application.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, useUi } from '../components';
import { useApp } from '../App';

interface LicenceState {
  activated: boolean;
  valid: boolean;
  organization: string | null;
  licenseId: string | null;
  type: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  deviceHash: string;
  deviceSummary: string;
  keyFingerprint: string;
  developmentKey: boolean;
  errors: string[];
  errorsBn: string[];
  evaluation: { mode: 'licensed' | 'evaluation' | 'expired'; daysLeft: number; startedAt: string | null; expiresAt: string | null };
}

interface Activation {
  licenseId: string;
  organization: string;
  type: string;
  expiresAt: string | null;
  activatedAt: string;
  deviceHash: string;
}

export function LicenseScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { appInfo, refreshSession } = useApp();
  const [state, setState] = useState<LicenceState | null>(null);
  const [licenceText, setLicenceText] = useState('');
  const [activating, setActivating] = useState(false);
  const [lastActivation, setLastActivation] = useState<Activation | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await call<LicenceState>('license', 'status'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const activateFromFile = async () => {
    setActivating(true);
    try {
      const result = await call<{ canceled?: boolean; activation?: Activation }>('license', 'activateFromFile');
      if (result.canceled || !result.activation) return;
      setLastActivation(result.activation);
      toast('success', lang === 'bn' ? 'লাইসেন্স সক্রিয় হয়েছে।' : 'Licence activated.');
      await load();
      await refreshSession();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    } finally {
      setActivating(false);
    }
  };

  const activateFromText = async () => {
    if (licenceText.trim() === '') {
      toast('warning', lang === 'bn' ? 'লাইসেন্সের বিষয়বস্তু পেস্ট করুন।' : 'Paste the licence contents first.');
      return;
    }
    setActivating(true);
    try {
      const activation = await call<Activation>('license', 'activateFromText', { text: licenceText.trim() });
      setLastActivation(activation);
      setLicenceText('');
      toast('success', lang === 'bn' ? 'লাইসেন্স সক্রিয় হয়েছে।' : 'Licence activated.');
      await load();
      await refreshSession();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    } finally {
      setActivating(false);
    }
  };

  if (!state) return <Spinner label={t('loading')} />;

  const expires = state.expiresAt ? state.expiresAt.slice(0, 10) : lang === 'bn' ? 'আজীবন' : 'Lifetime';

  return (
    <>
      <PageHeader
        title={t('navActivation')}
        subtitle={lang === 'bn' ? 'অফলাইন লাইসেন্স ব্যবস্থাপনা' : 'Offline licence management'}
        actions={
          <>
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button variant="primary" onClick={() => void activateFromFile()} loading={activating}>
              {t('activateLicense')}
            </Button>
          </>
        }
      />

      <div className="grid cols-2">
        <Card title={t('licenseStatus')}>
          <div className="stack">
            <div className="row between">
              <span className="muted">{t('status')}</span>
              {state.valid ? (
                <Badge tone="success">{t('licenseActive')}</Badge>
              ) : state.evaluation.mode === 'expired' ? (
                <Badge tone="danger">{lang === 'bn' ? 'সময় শেষ' : 'Evaluation ended'}</Badge>
              ) : (
                <Badge tone="warning">{lang === 'bn' ? 'পরীক্ষামূলক' : 'Evaluation'}</Badge>
              )}
            </div>
            <div className="row between">
              <span className="muted">{t('organization')}</span>
              <span>{state.organization ?? '—'}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'লাইসেন্স আইডি' : 'Licence ID'}</span>
              <span className="mono small">{state.licenseId ?? '—'}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'ধরন' : 'Type'}</span>
              <span>{state.type ?? '—'}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'মেয়াদ' : 'Expires'}</span>
              <span>{state.valid ? expires : '—'}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'সক্রিয় করার সময়' : 'Activated at'}</span>
              <span className="small">{state.activatedAt ? state.activatedAt.replace('T', ' ').slice(0, 16) : '—'}</span>
            </div>
            {!state.valid ? (
              <div className="row between">
                <span className="muted">
                  {lang === 'bn' ? 'পরীক্ষামূলক সময় বাকি' : 'Evaluation remaining'}
                </span>
                <span className={state.evaluation.daysLeft <= 3 ? 'text-warning' : ''}>
                  {state.evaluation.daysLeft} {lang === 'bn' ? 'দিন' : 'days'}
                </span>
              </div>
            ) : null}
          </div>

          {state.errorsBn.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <Alert tone="danger">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {state.errorsBn.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}

          {state.developmentKey ? (
            <div style={{ marginTop: 12 }}>
              <Alert tone="warning">
                {lang === 'bn'
                  ? 'এই বিল্ডে ডেভেলপমেন্ট ভেরিফিকেশন কী সংযুক্ত আছে। প্রকাশিত সংস্করণে এটি পরিবর্তন করতে হবে।'
                  : 'This build embeds a development verification key. Production builds must ship the owner key.'}
              </Alert>
            </div>
          ) : null}
        </Card>

        <Card title={t('deviceId')}>
          <div className="stack">
            <Field label={lang === 'bn' ? 'ডিভাইস আইডি (লাইসেন্স তৈরি করতে এই আইডি পাঠান)' : 'Device ID (send this to issue a licence)'}>
              <Input readOnly value={state.deviceHash} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Field label={lang === 'bn' ? 'হার্ডওয়্যার সারাংশ' : 'Hardware summary'}>
              <Input readOnly value={state.deviceSummary} />
            </Field>
            <Field label={lang === 'bn' ? 'ভেরিফিকেশন কী ফিঙ্গারপ্রিন্ট' : 'Verification key fingerprint'}>
              <Input readOnly value={state.keyFingerprint} />
            </Field>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(state.deviceHash);
                toast('success', lang === 'bn' ? 'কপি হয়েছে।' : 'Copied.');
              }}
            >
              {lang === 'bn' ? 'ডিভাইস আইডি কপি করুন' : 'Copy device ID'}
            </Button>
            <div className="small muted">
              {lang === 'bn'
                ? 'লাইসেন্স এই ডিভাইসের সাথে আবদ্ধ। অন্য কম্পিউটারে ব্যবহার করতে নতুন লাইসেন্স প্রয়োজন।'
                : 'The licence is bound to this device. Using MERQO on another computer requires a new licence.'}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title={lang === 'bn' ? 'লাইসেন্স কোড পেস্ট করুন' : 'Paste a licence'}>
          <div className="stack">
            <Field label={lang === 'bn' ? 'লাইসেন্স JSON' : 'Licence JSON'} hint={lang === 'bn' ? 'ফাইল না থাকলে এখানে কোড পেস্ট করুন' : 'Paste the file contents if you received them as text'}>
              <textarea
                className="textarea"
                style={{ minHeight: 160, fontFamily: 'var(--font-num)', fontSize: 11 }}
                value={licenceText}
                onChange={(e) => setLicenceText(e.target.value)}
                placeholder='{"format":"merqo-license/1", ...}'
              />
            </Field>
            <Button variant="primary" onClick={() => void activateFromText()} loading={activating}>
              {lang === 'bn' ? 'সক্রিয় করুন' : 'Activate'}
            </Button>
          </div>
        </Card>

        <Card title={lang === 'bn' ? 'সহায়তা' : 'Support'}>
          <div className="stack small">
            <div>
              <strong>{lang === 'bn' ? 'লাইসেন্স কীভাবে পাবেন' : 'How to get a licence'}</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {lang === 'bn'
                  ? 'উপরের ডিভাইস আইডি কপি করে merqoonline@gmail.com এ পাঠান। প্রতিষ্ঠানের নাম ও ধরন (আজীবন/বার্ষিক) লিখুন।'
                  : 'Copy the device ID above and send it to merqoonline@gmail.com with your organization name and licence type (lifetime/subscription).'}
              </p>
            </div>
            {lastActivation ? (
              <Alert tone="success">
                {lang === 'bn'
                  ? `সক্রিয় · ${lastActivation.organization} · ${lastActivation.licenseId}`
                  : `Activated · ${lastActivation.organization} · ${lastActivation.licenseId}`}
              </Alert>
            ) : null}
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'অ্যাপ সংস্করণ' : 'App version'}</span>
              <span className="mono">{appInfo.version}</span>
            </div>
            <div className="row between">
              <span className="muted">{lang === 'bn' ? 'লাইসেন্স ফরম্যাট' : 'Licence format'}</span>
              <span className="mono">merqo-license/1</span>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
