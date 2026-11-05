import semver from 'semver';
import { messageOf } from '../common/message.js';
import type { UpdateCheckResult } from '../common/types.js';

const REPO = 'j-carv/nanachi-remote-control';
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Installer asset published with a release: `Nanachi-Setup-<version>.exe`. */
const INSTALLER_ASSET = /^Nanachi-Setup-.+\.exe$/i;

/** Release page for a tag. Built from the tag, never taken from the API answer, so only github.com is ever opened. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

/**
 * Compares the installed version with the body of `GET /releases/latest`. An update exists only for a newer semver
 * tag that carries an installer asset; a release without the installer (or a draft or prerelease) is not offered.
 */
export function evaluateRelease(current: string, body: unknown): UpdateCheckResult {
  const upToDate: UpdateCheckResult = { status: 'up-to-date', current };
  if (typeof body !== 'object' || body === null) return upToDate;
  const release = body as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return upToDate;

  const tag = release.tag_name;
  if (typeof tag !== 'string') return upToDate;
  const latest = semver.valid(tag);
  if (latest === null || semver.valid(current) === null) return upToDate;
  if (!semver.gt(latest, current)) return upToDate;

  const assets: unknown[] = Array.isArray(release.assets) ? release.assets : [];
  const hasInstaller = assets.some(
    (asset) =>
      typeof asset === 'object' &&
      asset !== null &&
      typeof (asset as Record<string, unknown>).name === 'string' &&
      INSTALLER_ASSET.test((asset as { name: string }).name),
  );
  if (!hasInstaller) return upToDate;

  return { status: 'available', current, latest, url: releasePageUrl(tag) };
}

export interface CheckForUpdateOptions {
  currentVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One unauthenticated request to GitHub. Nothing is downloaded or installed; the answer only says what exists. */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const { currentVersion } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_LATEST_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': `Nanachi-Desktop/${currentVersion}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return { status: 'error', current: currentVersion, message: `Não foi possível consultar o GitHub: ${messageOf(error)}` };
  }

  // No release published yet.
  if (response.status === 404) return { status: 'up-to-date', current: currentVersion };
  if (!response.ok) {
    return { status: 'error', current: currentVersion, message: `O GitHub respondeu HTTP ${response.status}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'error', current: currentVersion, message: 'Resposta do GitHub ilegível.' };
  }
  return evaluateRelease(currentVersion, body);
}
