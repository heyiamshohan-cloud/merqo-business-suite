/**
 * Device identity collection for licence binding.
 *
 * Several independent identifiers are combined so that a cheap change (a new
 * network card, a renamed PC) does not invalidate a licence, while moving the
 * installation to a different computer does. All reads are defensive: a missing
 * value is simply omitted, never fatal.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, hostname, platform, release } from 'node:os';
import { deviceFingerprint } from '../core/licensing/license';

function tryExec(command: string, args: string[]): string | null {
  try {
    const out = execFileSync(command, args, { timeout: 4000, windowsHide: true });
    return out.toString().trim();
  } catch {
    return null;
  }
}

function windowsMachineGuid(): string | null {
  if (platform() !== 'win32') return null;
  const out = tryExec('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ]);
  if (!out) return null;
  const match = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
  return match?.[1] ?? null;
}

function windowsVolumeSerial(): string | null {
  if (platform() !== 'win32') return null;
  const out = tryExec('cmd', ['/c', 'vol', 'C:']);
  if (!out) return null;
  const match = out.match(/([0-9A-F]{4}-[0-9A-F]{4})/i);
  return match?.[1] ?? null;
}

function windowsProductUuid(): string | null {
  if (platform() !== 'win32') return null;
  const out = tryExec('powershell', [
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_ComputerSystemProduct).UUID',
  ]);
  if (!out) return null;
  const value = out.split(/\r?\n/).pop()?.trim();
  if (!value || value === 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') return null;
  return value;
}

export interface DeviceIdentity {
  fingerprint: string;
  /** Non-reversible summary shown in the activation screen for support. */
  summary: string;
  components: Record<string, string | null>;
}

export function collectDeviceIdentity(): DeviceIdentity {
  const cpu = cpus()[0]?.model ?? null;
  const components: Record<string, string | null> = {
    machineGuid: windowsMachineGuid(),
    volumeSerial: windowsVolumeSerial(),
    productUuid: windowsProductUuid(),
    hostname: hostname(),
    cpu,
    os: `${platform()}-${release()}`,
  };

  // Prefer hardware/OS identity; fall back progressively so a fingerprint can
  // always be produced.
  const strong = [components.machineGuid, components.productUuid, components.volumeSerial];
  const weak = [components.hostname, components.cpu, components.os];

  let fingerprint: string;
  if (strong.some((v) => !!v)) {
    fingerprint = deviceFingerprint(strong.filter((v): v is string => !!v));
  } else {
    fingerprint = deviceFingerprint([...strong, ...weak].filter((v): v is string => !!v));
  }

  const summary = createHash('sha256')
    .update(`${fingerprint}:${platform()}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  return { fingerprint, summary, components };
}
