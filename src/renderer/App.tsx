/**
 * Application shell: boot, navigation, session context and licence banner.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { call, onEvent, ApiError } from './api';
import { UiProvider, useUi, Spinner, Badge, Button } from './components';
import type { AppInfo, SessionInfo } from '../shared/types';
import type { Lang } from './i18n';
import { DashboardScreen } from './screens/Dashboard';
import { PosScreen } from './screens/Pos';
import { ProductsScreen } from './screens/Products';
import { SalesScreen } from './screens/Sales';
import { PurchasesScreen } from './screens/Purchases';
import { PartiesScreen } from './screens/Parties';
import { ExpensesScreen } from './screens/Expenses';
import { ReturnsScreen } from './screens/Returns';
import { ReportsScreen } from './screens/Reports';
import { BackupScreen } from './screens/Backup';
import { SettingsScreen } from './screens/Settings';
import { LicenseScreen } from './screens/License';
import { AboutScreen } from './screens/About';

export type Route =
  | 'dashboard'
  | 'pos'
  | 'products'
  | 'sales'
  | 'purchases'
  | 'customers'
  | 'suppliers'
  | 'expenses'
  | 'returns'
  | 'reports'
  | 'backup'
  | 'settings'
  | 'license'
  | 'about';

interface AppContextValue {
  session: SessionInfo;
  appInfo: AppInfo;
  refreshSession: () => Promise<void>;
  navigate: (route: Route) => void;
  route: Route;
  goToInvoice: (invoiceNo: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppContext');
  return ctx;
}

interface LicenceState {
  valid: boolean;
  activated: boolean;
  organization: string | null;
  type: string | null;
  expiresAt: string | null;
  evaluation: { mode: 'licensed' | 'evaluation' | 'expired'; daysLeft: number; expiresAt: string | null };
  deviceHash: string;
  errorsBn: string[];
}

const NAV: Array<{ group: string; items: Array<{ route: Route; icon: string; key: string; hint?: string }> }> = [
  {
    group: 'main',
    items: [
      { route: 'dashboard', icon: '▦', key: 'navDashboard' },
      { route: 'pos', icon: '₪', key: 'navPos', hint: 'F1' },
    ],
  },
  {
    group: 'records',
    items: [
      { route: 'sales', icon: '≡', key: 'navSales' },
      { route: 'purchases', icon: '⇲', key: 'navPurchases' },
      { route: 'products', icon: '▣', key: 'navProducts' },
      { route: 'returns', icon: '↩', key: 'navReturns' },
    ],
  },
  {
    group: 'parties',
    items: [
      { route: 'customers', icon: '☺', key: 'navCustomers' },
      { route: 'suppliers', icon: '⛟', key: 'navSuppliers' },
      { route: 'expenses', icon: '⊖', key: 'navExpenses' },
    ],
  },
  {
    group: 'insight',
    items: [
      { route: 'reports', icon: '⌸', key: 'navReports' },
      { route: 'backup', icon: '⟲', key: 'navBackup' },
    ],
  },
  {
    group: 'app',
    items: [
      { route: 'settings', icon: '⚙', key: 'navSettings' },
      { route: 'license', icon: '🔑', key: 'navActivation' },
      { route: 'about', icon: 'ⓘ', key: 'navAbout' },
    ],
  },
];

export default function App(): JSX.Element {
  const [boot, setBoot] = useState<{ session: SessionInfo; appInfo: AppInfo; licence: LicenceState } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>('dashboard');
  const [lang, setLang] = useState<Lang>('bn');

  const loadSession = useCallback(async () => {
    const [session, appInfo, licence] = await Promise.all([
      call<SessionInfo>('system', 'session'),
      call<AppInfo>('system', 'appInfo'),
      call<LicenceState>('license', 'status'),
    ]);
    return { session, appInfo, licence };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSession()
      .then((data) => {
        if (cancelled) return;
        setBoot(data);
        setLang(data.session.language);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBootError(err instanceof ApiError ? err.messageBn || err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  const refreshSession = useCallback(async () => {
    const data = await loadSession();
    setBoot(data);
  }, [loadSession]);

  useEffect(() => {
    const unsubscribe = onEvent((event) => {
      if (event.type === 'license-changed') void refreshSession();
    });
    return unsubscribe;
  }, [refreshSession]);

  const appContext = useMemo<AppContextValue | null>(() => {
    if (!boot) return null;
    return {
      session: boot.session,
      appInfo: boot.appInfo,
      refreshSession,
      navigate: setRoute,
      route,
      goToInvoice: (invoiceNo: string) => {
        void invoiceNo; // handled by the Sales screen search when navigated
        setRoute('sales');
      },
    };
  }, [boot, refreshSession, route]);

  if (bootError) {
    return (
      <div className="lock-screen">
        <div className="lock-card">
          <div className="lock-brand">MERQO</div>
          <h2 style={{ marginTop: 16 }}>Startup failed / চালু করা যায়নি</h2>
          <p className="muted">{bootError}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Retry / আবার চেষ্টা করুন
          </Button>
        </div>
      </div>
    );
  }

  if (!boot || !appContext) {
    return (
      <div className="lock-screen">
        <div className="lock-card">
          <div className="lock-brand">MERQO</div>
          <p className="lock-hint">Loading / লোড হচ্ছে…</p>
          <Spinner />
        </div>
      </div>
    );
  }

  const onLanguageChange = (next: Lang) => {
    setLang(next);
    void call('system', 'setLanguage', { language: next }).catch(() => undefined);
  };

  return (
    <UiProvider lang={lang} setLang={onLanguageChange}>
      <AppContext.Provider value={appContext}>
        <Shell licence={boot.licence} lang={lang} onLanguageChange={onLanguageChange} />
      </AppContext.Provider>
    </UiProvider>
  );
}

function Shell({
  licence,
  lang,
  onLanguageChange,
}: {
  licence: LicenceState;
  lang: Lang;
  onLanguageChange: (lang: Lang) => void;
}): JSX.Element {
  const { route, navigate, session, appInfo } = useApp();
  const { t } = useUi();

  // Global shortcuts: F1 opens the till from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        navigate('pos');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const businessName = lang === 'bn' && session.businessNameBn ? session.businessNameBn : session.businessName;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="wordmark">MERQO</div>
          <div className="tagline">{t('tagline')}</div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.group}>
              {group.items.map((item) => (
                <button
                  key={item.route}
                  className={`nav-item ${route === item.route ? 'active' : ''}`}
                  onClick={() => navigate(item.route)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{t(item.key as never)}</span>
                  {item.hint ? <span className="kbd-hint">{item.hint}</span> : null}
                </button>
              ))}
              {group.group !== 'app' ? <div style={{ height: 6 }} /> : null}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div>
            {session.businessName} · {appInfo.productName}
          </div>
          <div>
            v{appInfo.version} · {appInfo.platform}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            {businessName}
            <span className="sub">
              {session.user ? `${session.user.fullName} (${session.user.role})` : '—'}
            </span>
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            {licence.evaluation.mode === 'evaluation' && !licence.valid ? (
              <button
                className="badge warning"
                style={{ border: 0, cursor: 'pointer', height: 24 }}
                onClick={() => navigate('license')}
                title="Evaluation period / পরীক্ষামূলক সময়"
              >
                {lang === 'bn'
                  ? `পরীক্ষামূলক · ${licence.evaluation.daysLeft} দিন বাকি`
                  : `Evaluation · ${licence.evaluation.daysLeft} days left`}
              </button>
            ) : null}
            {licence.evaluation.mode === 'expired' && !licence.valid ? (
              <button className="badge danger" style={{ border: 0, cursor: 'pointer', height: 24 }} onClick={() => navigate('license')}>
                {lang === 'bn' ? 'শুধু পড়ার মোড · লাইসেন্স প্রয়োজন' : 'Read-only · licence required'}
              </button>
            ) : null}
            {licence.valid ? (
              <Badge tone="success">{lang === 'bn' ? 'লাইসেন্স সক্রিয়' : 'Licensed'}</Badge>
            ) : null}
            <div className="row" style={{ gap: 4 }}>
              <Button size="sm" variant={lang === 'bn' ? 'primary' : 'secondary'} onClick={() => onLanguageChange('bn')}>
                বাংলা
              </Button>
              <Button size="sm" variant={lang === 'en' ? 'primary' : 'secondary'} onClick={() => onLanguageChange('en')}>
                EN
              </Button>
            </div>
          </div>
        </header>

        {route === 'pos' ? (
          <div className="content flush">
            <PosScreen />
          </div>
        ) : (
          <main className="content">
            {route === 'dashboard' && <DashboardScreen />}
            {route === 'products' && <ProductsScreen />}
            {route === 'sales' && <SalesScreen />}
            {route === 'purchases' && <PurchasesScreen />}
            {route === 'customers' && <PartiesScreen kind="customer" />}
            {route === 'suppliers' && <PartiesScreen kind="supplier" />}
            {route === 'expenses' && <ExpensesScreen />}
            {route === 'returns' && <ReturnsScreen />}
            {route === 'reports' && <ReportsScreen />}
            {route === 'backup' && <BackupScreen />}
            {route === 'settings' && <SettingsScreen />}
            {route === 'license' && <LicenseScreen />}
            {route === 'about' && <AboutScreen />}
          </main>
        )}
      </div>
    </div>
  );
}
