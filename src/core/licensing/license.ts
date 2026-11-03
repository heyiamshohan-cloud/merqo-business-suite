/**
 * Offline licence system.
 *
 * Model: the owner holds an Ed25519 **private** key; the application ships only
 * the matching **public** key. A licence is a JSON document signed by the owner.
 * Verification happens entirely offline with `node:crypto` — no server, no
 * activation call, no telemetry.
 *
 * Security notes
 *  - Ed25519 (EdDSA) is used through Node's audited OpenSSL implementation. No
 *    custom cryptography exists anywhere in this file.
 *  - The signature covers a canonical (deterministically key-sorted) encoding of
 *    the payload, so a single changed byte invalidates the licence.
 *  - The private key never enters the repository, the installer, the customer
 *    licence file or any release artefact.
 *
 * Honest limitation: a fully offline application cannot be *remotely revoked*.
 * Revocation requires the customer to receive updated licence material.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { AppError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';
import { recordAudit } from '../services/audit';

export const LICENSE_FORMAT = 'merqo-license-v1';
export const LICENSE_PRODUCT = 'merqo-business-suite';

export type LicenseType = 'lifetime' | 'trial' | 'subscription';

export interface LicensePayload {
  format: typeof LICENSE_FORMAT;
  product: typeof LICENSE_PRODUCT;
  /** Licence format version, not the application version. */
  version: 1;
  licenseId: string;
  organization: string;
  ownerName?: string;
  phone?: string;
  email?: string;
  issuedAt: string;
  type: LicenseType;
  /** Null for lifetime licences. */
  expiresAt?: string | null;
  /** Informational: how many PCs the owner permitted. */
  maxDevices?: number | null;
  /** When set, the licence only validates on this device fingerprint. */
  deviceHash?: string | null;
  /** Highest application MAJOR version this licence covers (informational). */
  appMajorMax?: number | null;
  features?: string[];
  notes?: string;
}

export interface LicenseFile {
  format: typeof LICENSE_FORMAT;
  payload: LicensePayload;
  /** Base64 Ed25519 signature over the canonical payload. */
  signature: string;
  /** Short fingerprint of the signing key, for support purposes. */
  keyFingerprint: string;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
}

/** Generate a new Ed25519 key pair (owner-only action). */
export function generateLicenseKeyPair(passphrase?: string): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = passphrase
    ? privateKey
        .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })
        .toString()
    : privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, fingerprint: keyFingerprint(publicKeyPem) };
}

function privateKeyFromPem(pem: string, passphrase?: string): KeyObject {
  try {
    return createPrivateKey({ key: pem, format: 'pem', passphrase } as never);
  } catch (err) {
    throw new AppError('Unable to read the signing key (wrong passphrase or corrupt key)', {
      code: 'LICENSE_INVALID',
      messageBn: 'সাইনিং কী পড়া যায়নি। পাসফ্রেজ বা কী ফাইল যাচাই করুন।',
      cause: err,
    });
  }
}

/** Sign a licence payload. Owner-side only. */
export function signLicense(
  payload: Omit<LicensePayload, 'format' | 'product' | 'version'> & Partial<LicensePayload>,
  privateKeyPem: string,
  passphrase?: string,
): LicenseFile {
  const full: LicensePayload = {
    format: LICENSE_FORMAT,
    product: LICENSE_PRODUCT,
    version: 1,
    ...payload,
  } as LicensePayload;
  const data = Buffer.from(canonicalJson(full), 'utf8');
  const key = privateKeyFromPem(privateKeyPem, passphrase);
  const signature = cryptoSign(null, data, key).toString('base64');
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  return {
    format: LICENSE_FORMAT,
    payload: full,
    signature,
    keyFingerprint: keyFingerprint(publicKeyPem),
  };
}

export interface VerifyResult {
  valid: boolean;
  payload: LicensePayload | null;
  errors: string[];
  errorsBn: string[];
}

export interface VerifyOptions {
  publicKeyPem: string;
  /** Device fingerprint of this machine, when checking device binding. */
  deviceHash?: string;
  /** Current date for expiry checks (injectable for tests). */
  now?: Date;
  /** Highest application major version installed. */
  appMajor?: number;
}

/** Verify a licence file against the embedded public key. */
export function verifyLicense(
  license: LicenseFile | string,
  opts: VerifyOptions,
): VerifyResult {
  const errors: string[] = [];
  const errorsBn: string[] = [];

  let parsed: LicenseFile;
  try {
    parsed = typeof license === 'string' ? (JSON.parse(license) as LicenseFile) : license;
  } catch {
    return {
      valid: false,
      payload: null,
      errors: ['Licence file is not valid JSON'],
      errorsBn: ['লাইসেন্স ফাইল বিশুদ্ধ JSON নয়।'],
    };
  }

  if (parsed?.format !== LICENSE_FORMAT) {
    errors.push('Unknown licence format');
    errorsBn.push('অজানা লাইসেন্স ফরম্যাট।');
  }
  const payload = parsed?.payload;
  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      payload: null,
      errors: [...errors, 'Licence payload is missing'],
      errorsBn: [...errorsBn, 'লাইসেন্সের তথ্য পাওয়া যায়নি।'],
    };
  }

  if (payload.product !== LICENSE_PRODUCT) {
    errors.push(`Licence is for a different product (${String(payload.product)})`);
    errorsBn.push('এই লাইসেন্স ভিন্ন পণ্যের জন্য তৈরি।');
  }
  if (payload.version !== 1) {
    errors.push('Unsupported licence version');
    errorsBn.push('লাইসেন্স সংস্করণ সমর্থিত নয়।');
  }

  // Signature over the canonical payload.
  try {
    const data = Buffer.from(canonicalJson(payload), 'utf8');
    const publicKey = createPublicKey(opts.publicKeyPem);
    const ok = cryptoVerify(null, data, publicKey, Buffer.from(parsed.signature ?? '', 'base64'));
    if (!ok) {
      errors.push('Licence signature is invalid — the file has been modified');
      errorsBn.push('লাইসেন্স স্বাক্ষর সঠিক নয় — ফাইলটি পরিবর্তিত হয়েছে।');
    }
  } catch (err) {
    errors.push(`Signature verification failed: ${(err as Error).message}`);
    errorsBn.push('স্বাক্ষর যাচাই করা যায়নি।');
  }

  if (payload.type === 'trial' || payload.type === 'subscription') {
    if (payload.expiresAt) {
      const expires = new Date(payload.expiresAt).getTime();
      const now = (opts.now ?? new Date()).getTime();
      if (Number.isNaN(expires)) {
        errors.push('Licence expiry date is malformed');
        errorsBn.push('লাইসেন্সের মেয়াদ সঠিক নয়।');
      } else if (now > expires) {
        errors.push(`Licence expired on ${payload.expiresAt}`);
        errorsBn.push('লাইসেন্সের মেয়াদ শেষ হয়েছে।');
      }
    }
  }

  if (payload.deviceHash && opts.deviceHash && payload.deviceHash !== opts.deviceHash) {
    errors.push('Licence is bound to a different computer');
    errorsBn.push('এই লাইসেন্স অন্য কম্পিউটারের জন্য বাঁধাই করা হয়েছে।');
  }
  if (payload.appMajorMax && opts.appMajor && opts.appMajor > payload.appMajorMax) {
    errors.push('Licence does not cover this application version');
    errorsBn.push('এই লাইসেন্স এই অ্যাপ সংস্করণের জন্য নয়।');
  }

  return { valid: errors.length === 0, payload, errors, errorsBn };
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------
/**
 * Derive a stable device fingerprint from several identifiers.
 *
 * A single easily-changed id (e.g. MAC address) is not enough. The collector in
 * the main process supplies Windows machine GUID, volume serial, CPU info and
 * the OS install id; we hash the sorted, normalised set. Because the inputs are
 * stable across reinstallations of MERQO, ordinary hardware changes do not
 * break activation — and a re-issued licence can be generated by the owner when
 * they do.
 */
export function deviceFingerprint(parts: Array<string | null | undefined>): string {
  const cleaned = parts
    .map((p) => (p ?? '').trim().toLowerCase())
    .filter((p) => p.length > 0)
    .sort();
  if (cleaned.length === 0) {
    throw new AppError('No device identifiers were supplied', {
      code: 'LICENSE_DEVICE_MISMATCH',
      messageBn: 'ডিভাইস শনাক্ত করা যায়নি।',
    });
  }
  return `m1-${createHash('sha256').update(cleaned.join('|')).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Activation persistence
// ---------------------------------------------------------------------------
export interface ActivationRow {
  id: string;
  license_id: string;
  organization: string;
  payload_json: string;
  signature: string;
  device_hash: string;
  activated_at: string;
  status: 'active' | 'superseded' | 'revoked';
}

export interface ActivationInput {
  license: LicenseFile | string;
  deviceHash: string;
  publicKeyPem: string;
}

export interface ActivationResult {
  licenseId: string;
  organization: string;
  type: LicenseType;
  expiresAt: string | null;
  activatedAt: string;
  deviceHash: string;
}

/** Verify and persist an activation. */
export function activateLicense(ctx: Ctx, input: ActivationInput): ActivationResult {
  const result = verifyLicense(input.license, {
    publicKeyPem: input.publicKeyPem,
    deviceHash: input.deviceHash,
    now: new Date(ctx.clock.nowIso()),
  });
  if (!result.valid || !result.payload) {
    throw new AppError(`Licence rejected: ${result.errors.join('; ')}`, {
      code: 'LICENSE_INVALID',
      messageBn: result.errorsBn[0] ?? 'লাইসেন্স গ্রহণ করা হয়নি।',
      details: { errors: result.errors },
    });
  }
  const payload = result.payload;
  const licenseFile =
    typeof input.license === 'string' ? (JSON.parse(input.license) as LicenseFile) : input.license;
  const at = ctx.clock.nowIso();
  const id = newId();

  return ctx.db.transaction(() => {
    ctx.db.run("UPDATE license_state SET status = 'superseded' WHERE status = 'active'");
    ctx.db.run(
      `INSERT INTO license_state
        (id, license_id, organization, payload_json, signature, device_hash, activated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id,
        payload.licenseId,
        payload.organization,
        canonicalJson(payload),
        licenseFile.signature,
        input.deviceHash,
        at,
      ],
    );
    recordAudit(ctx, {
      action: 'license.activate',
      entity: 'license',
      entityId: id,
      severity: 'critical',
      details: {
        licenseId: payload.licenseId,
        organization: payload.organization,
        type: payload.type,
        deviceHash: input.deviceHash,
      },
    });
    return {
      licenseId: payload.licenseId,
      organization: payload.organization,
      type: payload.type,
      expiresAt: payload.expiresAt ?? null,
      activatedAt: at,
      deviceHash: input.deviceHash,
    };
  });
}

export interface LicenseStatus {
  activated: boolean;
  valid: boolean;
  organization: string | null;
  licenseId: string | null;
  type: LicenseType | null;
  expiresAt: string | null;
  activatedAt: string | null;
  deviceHash: string | null;
  errors: string[];
  errorsBn: string[];
}

/** Current licence status, re-verifying the stored signature every time. */
export function licenseStatus(
  ctx: Ctx,
  opts: { publicKeyPem: string; deviceHash?: string; appMajor?: number },
): LicenseStatus {
  const row = ctx.db.get<ActivationRow>(
    "SELECT * FROM license_state WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1",
  );
  if (!row) {
    return {
      activated: false,
      valid: false,
      organization: null,
      licenseId: null,
      type: null,
      expiresAt: null,
      activatedAt: null,
      deviceHash: null,
      errors: ['No licence is activated on this computer'],
      errorsBn: ['এই কম্পিউটারে কোনো লাইসেন্স সক্রিয় করা হয়নি।'],
    };
  }
  const license: LicenseFile = {
    format: LICENSE_FORMAT,
    payload: JSON.parse(row.payload_json) as LicensePayload,
    signature: row.signature,
    keyFingerprint: '',
  };
  const result = verifyLicense(license, {
    publicKeyPem: opts.publicKeyPem,
    deviceHash: opts.deviceHash,
    now: new Date(ctx.clock.nowIso()),
    appMajor: opts.appMajor,
  });
  return {
    activated: true,
    valid: result.valid,
    organization: row.organization,
    licenseId: row.license_id,
    type: license.payload.type,
    expiresAt: license.payload.expiresAt ?? null,
    activatedAt: row.activated_at,
    deviceHash: row.device_hash,
    errors: result.errors,
    errorsBn: result.errorsBn,
  };
}

/** Throw unless the application is properly licensed. */
export function assertLicensed(
  ctx: Ctx,
  opts: { publicKeyPem: string; deviceHash?: string; appMajor?: number },
): LicenseStatus {
  const status = licenseStatus(ctx, opts);
  if (!status.activated) {
    throw new AppError('MERQO is not activated', {
      code: 'LICENSE_MISSING',
      messageBn: 'MERQO সক্রিয় করা হয়নি। অনুগ্রহ করে লাইসেন্স সক্রিয় করুন।',
    });
  }
  if (!status.valid) {
    throw new AppError(`Licence is not valid: ${status.errors.join('; ')}`, {
      code: 'LICENSE_INVALID',
      messageBn: status.errorsBn[0] ?? 'লাইসেন্স সক্রিয় নয়।',
      details: { errors: status.errors },
    });
  }
  return status;
}

// ---------------------------------------------------------------------------
// Owner-side issuance records
// ---------------------------------------------------------------------------
export interface IssuanceRecord {
  licenseId: string;
  organization: string;
  issuedAt: string;
  type: LicenseType;
  expiresAt: string | null;
  deviceHash: string | null;
  revoked: boolean;
  notes: string;
  keyFingerprint: string;
  /** The signed licence itself, so the owner can re-export it later. */
  license: LicenseFile;
}

export function newLicenseId(now = new Date()): string {
  const y = now.getFullYear();
  const rand = createHash('sha256')
    .update(`${now.toISOString()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `MERQO-${y}-${rand}`;
}
