import { useMemo } from 'react';
import { createStateKeeper, type StateKeeper } from '../lib/oauthState';

/**
 * start() returns a fresh random value and keeps it in sessionStorage (this tab
 * only). verify() compares in constant time and removes it after one use.
 */
export function useOAuthState(): StateKeeper {
  return useMemo(() => createStateKeeper(window.sessionStorage), []);
}
