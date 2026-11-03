import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateLicense,
  assertLicensed,
  canonicalJson,
  deviceFingerprint,
  generateLicenseKeyPair,
  keyFingerprint,
  licenseStatus,
  newLicenseId,
  signLicense,
  verifyLicense,
  type LicenseFile,
} from '../src/core/licensing/license';
import { EMBEDDED_PUBLIC_KEY_PEM } from '../src/core/licensing/publicKey';
import { makeHarness, type TestHarness } from './helpers';

let h: TestHarness;
const keys = generateLicenseKeyPair();
const otherKeys = generateLicenseKeyPair();

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => h.close());

function makeLicense(overrides: Record<string, unknown> = {}): LicenseFile {
  return signLicense(
    {
      licenseId: 'MERQO-2026-TEST0001',
      organization: 'M/S Rahim Store',
      ownerName: 'Rahim Uddin',
      phone: '01711111111',
      issuedAt: '2026-01-01T00:00:00.000Z',
      type: 'lifetime',
      ...overrides,
    },
    keys.privateKeyPem,
  );
}

describe('licence signing and verification', () => {
  it('accepts a correctly signed licence', () => {
    const license = makeLicense();
    const result = verifyLicense(license, { publicKeyPem: keys.publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.payload?.organization).toBe('M/S Rahim Store');
    expect(result.payload?.type).toBe('lifetime');
  });

  it('rejects a licence signed with a different key', () => {
    const license = makeLicense();
    const result = verifyLicense(license, { publicKeyPem: otherKeys.publicKeyPem });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/signature/i);
  });

  it('detects any tampering with the payload', () => {
    const license = makeLicense();
    const tampered = JSON.parse(JSON.stringify(license)) as LicenseFile;
    tampered.payload.organization = 'Someone Else Ltd';
    const result = verifyLicense(tampered, { publicKeyPem: keys.publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('detects a tampered signature and malformed files', () => {
    const license = makeLicense();
    const badSig = { ...license, signature: 'AAAA' + license.signature.slice(4) };
    expect(verifyLicense(badSig, { publicKeyPem: keys.publicKeyPem }).valid).toBe(false);
    expect(verifyLicense('{not json', { publicKeyPem: keys.publicKeyPem }).valid).toBe(false);
    expect(verifyLicense('{}', { publicKeyPem: keys.publicKeyPem }).valid).toBe(false);
  });

  it('rejects a licence issued for another product', () => {
    const license = makeLicense();
    const forged = {
      ...license,
      payload: { ...license.payload, product: 'other-product' },
    } as unknown as LicenseFile;
    const result = verifyLicense(forged, { publicKeyPem: keys.publicKeyPem });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/different product/i);
  });

  it('enforces expiry for trial licences', () => {
    const license = makeLicense({ type: 'trial', expiresAt: '2026-02-01T00:00:00.000Z' });
    expect(
      verifyLicense(license, {
        publicKeyPem: keys.publicKeyPem,
        now: new Date('2026-01-15T00:00:00.000Z'),
      }).valid,
    ).toBe(true);
    const expired = verifyLicense(license, {
      publicKeyPem: keys.publicKeyPem,
      now: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(expired.valid).toBe(false);
    expect(expired.errors.join(' ')).toMatch(/expired/i);
  });

  it('never treats a lifetime licence as expiring', () => {
    const license = makeLicense({ expiresAt: null });
    expect(
      verifyLicense(license, {
        publicKeyPem: keys.publicKeyPem,
        now: new Date('2099-01-01T00:00:00.000Z'),
      }).valid,
    ).toBe(true);
  });

  it('enforces device binding when the licence carries a fingerprint', () => {
    const device = deviceFingerprint(['machine-guid-abc', 'volume-1234']);
    const license = makeLicense({ deviceHash: device });
    expect(
      verifyLicense(license, { publicKeyPem: keys.publicKeyPem, deviceHash: device }).valid,
    ).toBe(true);
    const other = deviceFingerprint(['machine-guid-xyz']);
    const result = verifyLicense(license, {
      publicKeyPem: keys.publicKeyPem,
      deviceHash: other,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/different computer/i);
  });

  it('produces a deterministic canonical encoding', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}]}');
  });

  it('separates public and private keys (private key is never embedded)', () => {
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.publicKeyPem).not.toContain('PRIVATE');
    expect(EMBEDDED_PUBLIC_KEY_PEM).not.toContain('PRIVATE');
    expect(EMBEDDED_PUBLIC_KEY_PEM).toContain('BEGIN PUBLIC KEY');
    expect(keyFingerprint(keys.publicKeyPem)).toHaveLength(16);
    expect(keyFingerprint(keys.publicKeyPem)).not.toBe(keyFingerprint(otherKeys.publicKeyPem));
  });

  it('generates unique licence identifiers', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLicenseId()));
    expect(ids.size).toBe(50);
    expect([...ids][0]).toMatch(/^MERQO-\d{4}-[A-F0-9]{8}$/);
  });
});

describe('activation lifecycle', () => {
  const device = deviceFingerprint(['dev-1']);

  it('blocks business operation before activation', () => {
    expect(() =>
      assertLicensed(h.ctx, { publicKeyPem: keys.publicKeyPem, deviceHash: device }),
    ).toThrow(/not activated/i);
    const status = licenseStatus(h.ctx, { publicKeyPem: keys.publicKeyPem, deviceHash: device });
    expect(status.activated).toBe(false);
    expect(status.valid).toBe(false);
  });

  it('activates and then reports a valid status', () => {
    const license = makeLicense({ deviceHash: device });
    const result = activateLicense(h.ctx, {
      license,
      deviceHash: device,
      publicKeyPem: keys.publicKeyPem,
    });
    expect(result.organization).toBe('M/S Rahim Store');

    const status = assertLicensed(h.ctx, {
      publicKeyPem: keys.publicKeyPem,
      deviceHash: device,
    });
    expect(status.valid).toBe(true);
    expect(status.type).toBe('lifetime');
    // Full offline operation: no network call was made.
    expect(h.db.count('license_state')).toBe(1);
  });

  it('rejects an invalid licence and leaves the application unlicensed', () => {
    const license = makeLicense();
    const tampered = { ...license, payload: { ...license.payload, organization: 'Hacked' } } as LicenseFile;
    expect(() =>
      activateLicense(h.ctx, {
        license: tampered,
        deviceHash: device,
        publicKeyPem: keys.publicKeyPem,
      }),
    ).toThrow();
    expect(h.db.count('license_state', "status = 'active'")).toBe(0);
  });

  it('supersedes a previous activation when a new licence is installed (recovery)', () => {
    activateLicense(h.ctx, {
      license: makeLicense({ licenseId: 'MERQO-2026-AAAA0001' }),
      deviceHash: device,
      publicKeyPem: keys.publicKeyPem,
    });
    // Windows reinstalled -> new device fingerprint -> owner reissues the licence
    const newDevice = deviceFingerprint(['dev-2']);
    const reissued = makeLicense({
      licenseId: 'MERQO-2026-BBBB0002',
      deviceHash: newDevice,
      notes: 'Reissued after Windows reinstall',
    });
    activateLicense(h.ctx, {
      license: reissued,
      deviceHash: newDevice,
      publicKeyPem: keys.publicKeyPem,
    });
    const active = h.db.all<{ license_id: string; status: string }>(
      'SELECT license_id, status FROM license_state ORDER BY activated_at',
    );
    expect(active).toHaveLength(2);
    expect(active.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(active.find((r) => r.status === 'active')?.license_id).toBe('MERQO-2026-BBBB0002');
  });

  it('re-verifies the stored signature on every status check (detects DB tampering)', () => {
    const license = makeLicense();
    activateLicense(h.ctx, { license, deviceHash: device, publicKeyPem: keys.publicKeyPem });
    // Attacker edits the stored payload directly in the database:
    h.db.run("UPDATE license_state SET payload_json = replace(payload_json, 'Rahim', 'Hacker')");
    const status = licenseStatus(h.ctx, { publicKeyPem: keys.publicKeyPem, deviceHash: device });
    expect(status.valid).toBe(false);
  });

  it('records activation in the audit trail', () => {
    activateLicense(h.ctx, {
      license: makeLicense(),
      deviceHash: device,
      publicKeyPem: keys.publicKeyPem,
    });
    const audit = h.db.get<{ action: string; severity: string }>(
      "SELECT action, severity FROM audit_log WHERE action = 'license.activate'",
    );
    expect(audit?.severity).toBe('critical');
  });
});
