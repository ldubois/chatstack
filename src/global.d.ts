import type { ShellApi } from './shared/types';

declare global {
  interface Window {
    chatstack: ShellApi;
  }
}

export {};
