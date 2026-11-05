import type { ControlApi } from '../common/control-api.js';

declare global {
  interface Window {
    /** Exposed by `src/preload/control.ts`. Missing when the page is opened outside Nanachi Desktop. */
    nanachiControl?: ControlApi;
  }

  /**
   * True only in a build made for the throwaway screenshot and development flow (`NANACHI_CONTROL_MOCK=1`): the mock
   * `ControlApi` is bundled and `?mock=1` installs it. False in every shipped build, where the branch is dead code.
   */
  const __CONTROL_MOCK__: boolean;
}

export {};
