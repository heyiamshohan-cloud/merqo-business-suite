/**
 * Settings.
 *
 * Everything that changes how documents look or how stock behaves lives here.
 * Saving a setting writes an audit entry (done in the core), so a change of VAT
 * rate or a switch to "allow negative stock" is attributable to an operator.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Spinner, useUi } from '../components';
import { useApp } from '../App';

export function SettingsScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { refreshSession } = useApp();
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [printers, setPrinters] = useState<Array<{ name: string; displayName: string; isDefault: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [all, printerList] = await Promise.all([
        call<Record<string, string>>('settings', 'all'),
        call<Array<{ name: string; displayName: string; isDefault: boolean }>>('printing', 'printers').catch(
          () => [],
        ),
      ]);
      setSettings(all);
      setPrinters(printerList);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = (key: string): string => dirty[key] ?? settings?.[key] ?? '';
  const setValue = (key: string, next: string) => setDirty((prev) => ({ ...prev, [key]: next }));

  const save = async () => {
    if (Object.keys(dirty).length === 0) return;
    setSaving(true);
    try {
      await call('settings', 'update', { patch: dirty });
      toast('success', t('saved'));
      setDirty({});
      await load();
      await refreshSession();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const testPrint = async () => {
    setTesting(true);
    try {
      const paper = Number(value('printing.paper_width_mm')) === 58 ? 58 : 80;
      const result = await call<{ ok: boolean; reason?: string }>('printing', 'testPrint', {
        deviceName: value('printing.printer_name') || undefined,
        paperWidthMm: paper,
      });
      if (result.ok) toast('success', lang === 'bn' ? 'টেস্ট পেজ পাঠানো হয়েছে।' : 'Test page sent.');
      else toast('warning', result.reason ?? (lang === 'bn' ? 'প্রিন্টার পাওয়া যায়নি।' : 'Printer unavailable.'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setTesting(false);
    }
  };

  if (!settings) return <Spinner label={t('loading')} />;

  return (
    <>
      <PageHeader
        title={t('navSettings')}
        subtitle={lang === 'bn' ? 'ব্যবসার তথ্য, প্রিন্টিং ও স্টক নীতি' : 'Business details, printing and stock policy'}
        actions={
          <>
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()} disabled={Object.keys(dirty).length === 0}>
              {t('save')} {Object.keys(dirty).length > 0 ? `(${Object.keys(dirty).length})` : ''}
            </Button>
          </>
        }
      />

      <div className="grid cols-2">
        <Card title={t('businessInfo')}>
          <div className="form-grid">
            <Field label={t('businessName')} required>
              <Input value={value('business.name')} onChange={(e) => setValue('business.name', e.target.value)} />
            </Field>
            <Field label={lang === 'bn' ? 'ব্যবসার নাম (বাংলা)' : 'Business name (Bengali)'}>
              <Input value={value('business.name_bn')} onChange={(e) => setValue('business.name_bn', e.target.value)} />
            </Field>
            <Field label={t('address')} className="span-2">
              <Input value={value('business.address')} onChange={(e) => setValue('business.address', e.target.value)} />
            </Field>
            <Field label={t('phone')}>
              <Input value={value('business.phone')} onChange={(e) => setValue('business.phone', e.target.value)} />
            </Field>
            <Field label={lang === 'bn' ? 'ইমেইল' : 'Email'}>
              <Input value={value('business.email')} onChange={(e) => setValue('business.email', e.target.value)} />
            </Field>
            <Field label={lang === 'bn' ? 'মালিকের নাম' : 'Owner name'}>
              <Input value={value('business.owner_name')} onChange={(e) => setValue('business.owner_name', e.target.value)} />
            </Field>
            <Field label={t('vatRegNo')}>
              <Input value={value('business.vat_reg_no')} onChange={(e) => setValue('business.vat_reg_no', e.target.value)} />
            </Field>
            <Field label={t('invoiceFooter')} className="span-2">
              <Input value={value('invoice.footer')} onChange={(e) => setValue('invoice.footer', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title={t('printing')}>
          <div className="form-grid">
            <Field label={t('printerName')} hint={lang === 'bn' ? 'খালি রাখলে Windows-এর ডিফল্ট প্রিন্টার' : 'Blank uses the Windows default'}>
              <Select
                value={value('printing.printer_name')}
                onChange={(e) => setValue('printing.printer_name', e.target.value)}
                options={[
                  { value: '', label: lang === 'bn' ? '(ডিফল্ট)' : '(Default)' },
                  ...printers.map((p) => ({ value: p.name, label: p.displayName })),
                ]}
              />
            </Field>
            <Field label={t('paperWidth')}>
              <Select
                value={value('printing.paper_width_mm') || '80'}
                onChange={(e) => setValue('printing.paper_width_mm', e.target.value)}
                options={[
                  { value: '58', label: '58 mm' },
                  { value: '80', label: '80 mm' },
                ]}
              />
            </Field>
            <Field label={lang === 'bn' ? 'কপি সংখ্যা' : 'Copies'}>
              <Input
                className="num"
                value={value('printing.copies')}
                onChange={(e) => setValue('printing.copies', e.target.value)}
              />
            </Field>
            <Field label={lang === 'bn' ? 'প্রিন্ট মোড' : 'Print mode'} hint={lang === 'bn' ? 'Windows ড্রাইভার সুপারিশকৃত' : 'Windows driver is recommended'}>
              <Select
                value={value('printing.mode') || 'windows'}
                onChange={(e) => setValue('printing.mode', e.target.value)}
                options={[
                  { value: 'windows', label: lang === 'bn' ? 'Windows ড্রাইভার' : 'Windows driver' },
                  { value: 'escpos-raw', label: 'ESC/POS raw' },
                ]}
              />
            </Field>
            <div className="span-2 row" style={{ gap: 8 }}>
              <Button onClick={() => void testPrint()} loading={testing}>
                {t('testPrint')}
              </Button>
              <span className="small muted">
                {lang === 'bn'
                  ? 'টেস্ট পেজে বাংলা যুক্তাক্ষর ও ৳ চিহ্ন থাকে — কাগজে ঠিকভাবে আসছে কিনা দেখুন।'
                  : 'The test page includes Bengali conjuncts and ৳ so you can check the paper output.'}
              </span>
            </div>
          </div>
        </Card>

        <Card title={t('inventorySettings')}>
          <div className="form-grid">
            <Field label={t('allowNegative')}>
              <Select
                value={value('inventory.allow_negative')}
                onChange={(e) => setValue('inventory.allow_negative', e.target.value)}
                options={[
                  { value: '0', label: lang === 'bn' ? 'না (সুপারিশকৃত)' : 'No (recommended)' },
                  { value: '1', label: lang === 'bn' ? 'হ্যাঁ' : 'Yes' },
                ]}
              />
            </Field>
            <Field label={lang === 'bn' ? 'কম স্টক থ্রেশহোল্ড' : 'Low stock threshold'}>
              <Input
                className="num"
                value={value('inventory.low_stock_threshold')}
                onChange={(e) => setValue('inventory.low_stock_threshold', e.target.value)}
              />
            </Field>
            <Field label={t('taxEnabled')}>
              <Select
                value={value('tax.enabled')}
                onChange={(e) => setValue('tax.enabled', e.target.value)}
                options={[
                  { value: '0', label: lang === 'bn' ? 'বন্ধ' : 'Off' },
                  { value: '1', label: lang === 'bn' ? 'চালু' : 'On' },
                ]}
              />
            </Field>
            <Field label={lang === 'bn' ? 'ভ্যাটের নাম' : 'Tax label'}>
              <Input value={value('tax.label')} onChange={(e) => setValue('tax.label', e.target.value)} />
            </Field>
            <Field label={lang === 'bn' ? 'মূল্যে ভ্যাট অন্তর্ভুক্ত' : 'Prices include VAT'}>
              <Select
                value={value('tax.prices_include_tax')}
                onChange={(e) => setValue('tax.prices_include_tax', e.target.value)}
                options={[
                  { value: '0', label: lang === 'bn' ? 'না' : 'No' },
                  { value: '1', label: lang === 'bn' ? 'হ্যাঁ' : 'Yes' },
                ]}
              />
            </Field>
            <Field label={t('language')}>
              <Select
                value={value('app.language')}
                onChange={(e) => setValue('app.language', e.target.value)}
                options={[
                  { value: 'bn', label: 'বাংলা' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </Field>
          </div>
        </Card>

        <Card title={t('backupSettings')}>
          <div className="form-grid">
            <Field label={t('autoBackup')}>
              <Select
                value={value('backup.auto_enabled')}
                onChange={(e) => setValue('backup.auto_enabled', e.target.value)}
                options={[
                  { value: '1', label: lang === 'bn' ? 'চালু' : 'On' },
                  { value: '0', label: lang === 'bn' ? 'বন্ধ' : 'Off' },
                ]}
              />
            </Field>
            <Field label={lang === 'bn' ? 'ফ্রিকোয়েন্সি' : 'Frequency'}>
              <Select
                value={value('backup.frequency')}
                onChange={(e) => setValue('backup.frequency', e.target.value)}
                options={[
                  { value: 'daily', label: lang === 'bn' ? 'প্রতিদিন' : 'Daily' },
                  { value: 'weekly', label: lang === 'bn' ? 'সাপ্তাহিক' : 'Weekly' },
                  { value: 'manual', label: lang === 'bn' ? 'শুধু ম্যানুয়াল' : 'Manual only' },
                ]}
              />
            </Field>
            <Field label={t('backupLocation')} className="span-2" hint={lang === 'bn' ? 'যেমন D:\\MERQO-Backups' : 'e.g. D:\\MERQO-Backups'}>
              <Input value={value('backup.location')} onChange={(e) => setValue('backup.location', e.target.value)} />
            </Field>
            <Field label={lang === 'bn' ? 'সংরক্ষণ সংখ্যা' : 'Retention count'}>
              <Input
                className="num"
                value={value('backup.retention_count')}
                onChange={(e) => setValue('backup.retention_count', e.target.value)}
              />
            </Field>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Alert tone="info">
          {lang === 'bn'
            ? 'মনে রাখবেন: ভ্যাট চালু বা বন্ধ করা নতুন লেনদেনে প্রযোজ্য হবে — পুরনো ভাউচার পরিবর্তন হবে না।'
            : 'Note: enabling or disabling VAT applies to new transactions only; existing documents are never rewritten.'}
        </Alert>
      </div>
    </>
  );
}
