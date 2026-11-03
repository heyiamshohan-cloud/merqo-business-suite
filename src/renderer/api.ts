/**
 * Renderer API client.
 *
 * Talks to the main process only through the preload bridge. Every call returns
 * a typed value or throws an `ApiError` carrying the Bengali message produced by
 * the business layer, so screens never invent their own error text.
 */
import type { AppEvent, IpcResponse } from '../shared/types';
import type { MerqoBridge } from '../preload/index';

declare global {
  interface Window {
    merqo?: MerqoBridge;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly messageBn: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function bridge(): MerqoBridge {
  if (!window.merqo) {
    throw new ApiError('NO_BRIDGE', 'Application bridge is unavailable', 'অ্যাপ্লিকেশন সেতু পাওয়া যায়নি।');
  }
  return window.merqo;
}

export async function call<T = unknown>(
  module: string,
  method: string,
  args?: unknown,
): Promise<T> {
  const response: IpcResponse<T> = await bridge().call<T>(module, method, args);
  if (!response.ok) {
    throw new ApiError(
      response.error.code,
      response.error.message,
      response.error.messageBn,
      response.error.details,
    );
  }
  return response.data;
}

export function onEvent(listener: (event: AppEvent) => void): () => void {
  if (!window.merqo) return () => undefined;
  return window.merqo.onEvent(listener);
}

export const hasBridge = (): boolean => typeof window !== 'undefined' && !!window.merqo;
