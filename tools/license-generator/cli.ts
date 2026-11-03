#!/usr/bin/env node
/**
 * MERQO Licence Generator — OWNER ONLY.
 *
 * This tool holds no key material of its own: it operates on the private key
 * file supplied with `--key`. That key must never be committed, never shipped in
 * the customer installer, and never placed in a public release asset.
 *
 * Commands
 *   keygen     create an Ed25519 key pair (private key written with 0600)
 *   issue      sign a licence file for a device ID and/or organisation
 *   inspect    decode a licence file and verify its signature
 *   verify     verify a licence against a specific device ID
 *   device     print this machine's device ID (for testing)
 *   keyid      print the fingerprint of a public key
 *
 * Exit codes: 0 success, 1 invalid input, 2 verification failed.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  generateLicenseKeyPair,
  keyFingerprint,
  signLicense,
  verifyLicense,
  LICENSE_FORMAT,
  type LicenseFile,
  type LicenseType,
} from '../../src/core/licensing/license';
import { collectDeviceIdentity } from '../../src/main/device';

const BANNER = 'MERQO LICENCE GENERATOR — OWNER ONLY — do not distribute';

interface Args {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; args: Args } {
  const command = argv[0] ?? 'help';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return { command, args };
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function num(args: Args, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readText(path: string, label: string): string {
  if (!existsSync(path)) fail(`${label} not found: ${path}`);
  return readFileSync(path, 'utf8');
}

function writeSecret(path: string, content: string): void {
  const dir = dirname(resolve(path));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: mode is best-effort */
  }
}

const HELP = `${BANNER}

Usage: merqo-license <command> [options]

  keygen  --out <dir> [--passphrase <secret>]
  issue   --key <private.pem> --org "<name>" --type lifetime|subscription|trial
          [--device <device-id>] [--expires YYYY-MM-DD] [--owner "<name>"]
          [--phone <number>] [--email <address>] [--max-devices <n>]
          [--features "reports,backup"] [--app-major <n>] [--out <file.merqo>]
          [--passphrase <secret>]
  inspect --file <file.merqo> [--pub <public.pem>]   (add --pub to check signature)
  verify  --file <file.merqo> --pub <public.pem> --device <device-id>
  device
  keyid   --pub <public.pem>

The licence is a JSON document signed with Ed25519. MERQO verifies it offline
against the public key embedded in the application.
`;

function main(): void {
  const { command, args } = parseArgs(process.argv.slice(2));
  const passphrase = str(args, 'passphrase');

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  console.log(BANNER);

  if (command === 'keygen') {
    const outDir = str(args, 'out') ?? './owner-keys';
    const pair = generateLicenseKeyPair(passphrase);
    const privatePath = resolve(outDir, 'merqo-private.pem');
    const publicPath = resolve(outDir, 'merqo-public.pem');
    writeSecret(privatePath, pair.privateKeyPem);
    writeFileSync(publicPath, pair.publicKeyPem);
    console.log(`private key : ${privatePath}  (chmod 600 — never commit)`);
    console.log(`public key  : ${publicPath}`);
    console.log(`fingerprint : ${keyFingerprint(pair.publicKeyPem)}`);
    console.log(`encrypted   : ${passphrase ? 'yes' : 'no'}`);
    return;
  }

  if (command === 'issue') {
    const keyPath = str(args, 'key') ?? fail('--key <private.pem> is required');
    const org = str(args, 'org') ?? fail('--org "<organisation>" is required');
    const type = (str(args, 'type') ?? 'lifetime') as LicenseType;
    if (!['lifetime', 'subscription', 'trial'].includes(type)) {
      fail('--type must be lifetime, subscription or trial');
    }
    const expiresAtRaw = str(args, 'expires');
    if ((type === 'trial' || type === 'subscription') && !expiresAtRaw) {
      fail(`--expires is required for a ${type} licence`);
    }
    const expiresAt = expiresAtRaw ? new Date(`${expiresAtRaw}T23:59:59.000Z`).toISOString() : null;
    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) fail('--expires must be YYYY-MM-DD');

    const privateKeyPem = readText(keyPath, 'private key');
    const licenseId =
      str(args, 'id') ?? `MERQO-${new Date().getUTCFullYear()}-${randomIdSuffix()}`;

    const file = signLicense(
      {
        licenseId,
        organization: org,
        ownerName: str(args, 'owner'),
        phone: str(args, 'phone'),
        email: str(args, 'email'),
        issuedAt: new Date().toISOString(),
        type,
        expiresAt,
        maxDevices: num(args, 'max-devices') ?? 1,
        deviceHash: str(args, 'device') ?? null,
        appMajorMax: num(args, 'app-major') ?? null,
        features: (str(args, 'features') ?? '')
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        notes: str(args, 'notes'),
      },
      privateKeyPem,
      passphrase,
    );

    const outPath = str(args, 'out') ?? `./${licenseId}.merqo`;
    writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    console.log(`licence id  : ${file.payload.licenseId}`);
    console.log(`organization: ${file.payload.organization}`);
    console.log(`type        : ${file.payload.type}${file.payload.expiresAt ? ` until ${file.payload.expiresAt.slice(0, 10)}` : ' (no expiry)'}`);
    console.log(`device      : ${file.payload.deviceHash ?? 'any device'}`);
    console.log(`key id      : ${file.keyFingerprint}`);
    console.log(`written     : ${outPath}`);
    return;
  }

  if (command === 'inspect') {
    const filePath = str(args, 'file') ?? fail('--file <file.merqo> is required');
    const licence = JSON.parse(readText(filePath, 'licence file')) as LicenseFile;
    console.log(JSON.stringify(licence.payload, null, 2));
    console.log(`signature   : ${licence.signature.slice(0, 32)}…`);
    console.log(`key id      : ${licence.keyFingerprint}`);
    const pubPath = str(args, 'pub');
    if (pubPath) {
      const result = verifyLicense(licence, { publicKeyPem: readText(pubPath, 'public key') });
      console.log(`valid now   : ${result.valid}`);
      if (!result.valid) {
        console.log(`errors      : ${result.errors.join('; ')}`);
        process.exit(2);
      }
    }
    return;
  }

  if (command === 'verify') {
    const filePath = str(args, 'file') ?? fail('--file <file.merqo> is required');
    const pubPath = str(args, 'pub') ?? fail('--pub <public.pem> is required');
    const device = str(args, 'device');
    const licence = JSON.parse(readText(filePath, 'licence file')) as LicenseFile;
    const result = verifyLicense(licence, {
      publicKeyPem: readText(pubPath, 'public key'),
      deviceHash: device,
    });
    console.log(`valid       : ${result.valid}`);
    if (!result.valid) {
      console.log(`errors      : ${result.errors.join('; ')}`);
      process.exit(2);
    }
    return;
  }

  if (command === 'device') {
    const identity = collectDeviceIdentity();
    console.log(`device id   : ${identity.fingerprint}`);
    console.log(`components  : ${identity.summary}`);
    return;
  }

  if (command === 'keyid') {
    const pubPath = str(args, 'pub') ?? fail('--pub <public.pem> is required');
    console.log(keyFingerprint(readText(pubPath, 'public key')));
    return;
  }

  console.error(`unknown command "${command}"\n`);
  console.log(HELP);
  process.exit(1);
}

function randomIdSuffix(): string {
  const random = createHash('sha256').update(String(Math.random()) + String(Date.now())).digest('hex');
  return random.slice(0, 8).toUpperCase();
}

main();
