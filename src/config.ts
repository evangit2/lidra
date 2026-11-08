/**
 * Typed access to persistent state through electron-conf. Defaults belong to
 * getters so an absent storefront still triggers the system-region fallback.
 */
import { Conf } from 'electron-conf/main';
import log from 'electron-log/main';
import type { ThemeName } from './theme';
import {
  DEFAULT_SERVICE_ID,
  isMusicServiceId,
  type AnyStartPageId,
  type ClassicalStartPageId,
  type MusicServiceId,
  type MusicStartPageId,
} from './musicService';

const configLog = log.scope('config');

/** A play held for later Last.fm submission, with a timestamp in Unix seconds. */
export interface PendingScrobble {
  artist: string;
  track: string;
  timestamp: number;
  album?: string;
  durationSec?: number;
  chosenByUser?: 0;
}

interface StoreSchema {
  storefront: string;
  language: string | null;
  'notifications.enabled': boolean;
  'discord.enabled': boolean;
  'closeToTray.enabled': boolean;
  'lastfm.enabled': boolean;
  'lastfm.apiUrl': string | null;
  'lastfm.pendingDestination': string;
  'lastfm.sessionKey': string | null;
  'lastfm.username': string | null;
  'lastfm.pendingScrobbles': PendingScrobble[];
  theme: ThemeName;
  'autoUpdate.enabled': boolean;
  startPage: MusicStartPageId | 'last';
  lastPageUrl: string;
  'classical.startPage': ClassicalStartPageId | 'last';
  'classical.lastPageUrl': string;
  'classical.language': string | null;
  zoomFactor: number;
  musicService: MusicServiceId;
  'audio.enabled': boolean;
  'audio.quality': string;
  'audio.keyTransport': string;
  'audio.keyService': string;
  'audio.keyToken': string | null;
  'audio.ffmpegPath': string | null;
  'audio.emeShim': boolean;
  'audio.decryptorService': string;
  'audio.manifestService': string;
}

const store = new Conf<StoreSchema>();

// Seed once before any caller can change Music's legacy preference. Persist null
// for an absent legacy key so a later launch cannot seed from a new Music choice.
if (!store.has('classical.language')) {
  store.set('classical.language', store.has('language') ? store.get('language') ?? null : null);
  configLog.info('classical.language initialised');
}

/** Reads a key, or the caller's default when the user has never set it. */
function getConfigValue<K extends keyof StoreSchema>(key: K, defaultValue: StoreSchema[K]): StoreSchema[K] {
  if (!store.has(key)) return defaultValue;
  return store.get(key);
}

/**
 * Reads a key and returns undefined when it has never been set, for the keys
 * where absence means something: an unset storefront defers to the system
 * locale, while a stored null is the user's own choice.
 */
function getConfigValueOptional<K extends keyof StoreSchema>(key: K): StoreSchema[K] | undefined {
  if (!store.has(key)) return undefined;
  return store.get(key);
}

/** Environment override for headless/CI setups and power users. */
function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Writes a key and logs it. The message is derived from the typed key, so a
 * rename cannot leave a stale key name in the log text.
 */
function setConfigValue<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
  store.set(key, value);
  configLog.info(`${key} set:`, value);
}

/** Read `storefront`, returning undefined when the key is absent. */
export function getStorefront(): string | undefined {
  return getConfigValueOptional('storefront');
}

/** Persist `storefront` without applying the setting to running components. */
export function setStorefront(code: string): void {
  setConfigValue('storefront', code);
}

/** Read `language`, returning undefined when the key is absent. */
export function getLanguage(): string | null | undefined {
  return getConfigValueOptional('language');
}

/** Persist `language` without applying the setting to running components. */
export function setLanguage(lang: string | null): void {
  setConfigValue('language', lang);
}

/** Read `notifications.enabled`, defaulting to `true` when absent. */
export function getNotificationsEnabled(): boolean {
  return getConfigValue('notifications.enabled', true);
}

/** Persist `notifications.enabled` without applying the setting to running components. */
export function setNotificationsEnabled(enabled: boolean): void {
  setConfigValue('notifications.enabled', enabled);
}

/** Read `closeToTray.enabled`, defaulting to `false` when absent. */
export function getCloseToTrayEnabled(): boolean {
  return getConfigValue('closeToTray.enabled', false);
}

/** Persist `closeToTray.enabled` without applying the setting to running components. */
export function setCloseToTrayEnabled(enabled: boolean): void {
  setConfigValue('closeToTray.enabled', enabled);
}

/** Read `discord.enabled`, defaulting to `false` when absent. */
export function getDiscordEnabled(): boolean {
  return getConfigValue('discord.enabled', false);
}

/** Persist `discord.enabled` without applying the setting to running components. */
export function setDiscordEnabled(enabled: boolean): void {
  setConfigValue('discord.enabled', enabled);
}

/** Read `lastfm.enabled`, defaulting to `false` when absent. */
export function getLastfmEnabled(): boolean {
  return getConfigValue('lastfm.enabled', false);
}

/** Persist `lastfm.enabled` without applying the setting to running components. */
export function setLastfmEnabled(enabled: boolean): void {
  setConfigValue('lastfm.enabled', enabled);
}

export function getLastfmApiUrl(): string | null | undefined {
  return getConfigValueOptional('lastfm.apiUrl');
}

export function setLastfmApiUrl(url: string | null): void {
  store.set('lastfm.apiUrl', url);
  configLog.info('lastfm.apiUrl set');
}

export function getPendingScrobbleDestination(): string {
  return getConfigValue('lastfm.pendingDestination', 'lastfm');
}

export function setPendingScrobbleDestination(destination: string): void {
  store.set('lastfm.pendingDestination', destination);
  configLog.info('lastfm.pendingDestination set');
}

/** Read `lastfm.sessionKey`, returning undefined when the key is absent. */
export function getLastfmSessionKey(): string | null | undefined {
  return getConfigValueOptional('lastfm.sessionKey');
}

/** Read `lastfm.username`, returning undefined when the key is absent. */
export function getLastfmUsername(): string | null | undefined {
  return getConfigValueOptional('lastfm.username');
}

/** Store the Last.fm session and username without logging the session key. */
export function setLastfmSession(sessionKey: string, username: string): void {
  store.set('lastfm.sessionKey', sessionKey);
  store.set('lastfm.username', username);
  configLog.info('lastfm session set for user:', username);
}

/** Clear Last.fm credentials without changing the enabled preference or pending queue. */
export function clearLastfmSession(): void {
  store.set('lastfm.sessionKey', null);
  store.set('lastfm.username', null);
  configLog.info('lastfm session cleared');
}

/**
 * Validate every stored field because one malformed play can invalidate a
 * Last.fm batch. Timestamps and durations match the integration's positive
 * whole seconds. Reject future timestamps because Last.fm can ignore them in a
 * successful response, after which the queue drops them.
 */
function isPendingScrobble(value: unknown): value is PendingScrobble {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PendingScrobble>;
  return typeof entry.artist === 'string' && entry.artist.length > 0
    && typeof entry.track === 'string' && entry.track.length > 0
    && typeof entry.timestamp === 'number'
    && Number.isInteger(entry.timestamp) && entry.timestamp > 0
    && entry.timestamp <= Math.floor(Date.now() / 1000)
    && (entry.album === undefined || typeof entry.album === 'string')
    && (entry.durationSec === undefined
      || (typeof entry.durationSec === 'number'
        && Number.isInteger(entry.durationSec) && entry.durationSec > 0))
    && (entry.chosenByUser === undefined || entry.chosenByUser === 0);
}

/** Read pending plays and discard malformed entries without logging listening history. */
export function getPendingScrobbles(): PendingScrobble[] {
  const stored: unknown = getConfigValue('lastfm.pendingScrobbles', []);
  if (!Array.isArray(stored)) {
    configLog.warn('lastfm.pendingScrobbles is not an array - discarding');
    return [];
  }
  const entries = stored.filter(isPendingScrobble);
  if (entries.length !== stored.length) {
    // Never log the dropped entries: track titles are the user's listening history.
    configLog.warn('lastfm.pendingScrobbles dropped malformed entries:', stored.length - entries.length);
  }
  return entries;
}

/** Replace the pending queue and log its length, not its contents. */
export function setPendingScrobbles(entries: PendingScrobble[]): void {
  store.set('lastfm.pendingScrobbles', entries);
  configLog.info('lastfm.pendingScrobbles set, queued:', entries.length);
}

/** Read `theme`, defaulting to `'apple-music'` when absent. */
export function getTheme(): ThemeName {
  return getConfigValue('theme', 'apple-music');
}

/** Persist `theme` without applying the setting to running components. */
export function setTheme(name: ThemeName): void {
  setConfigValue('theme', name);
}

/** Read `autoUpdate.enabled`, defaulting to `true` when absent. */
export function getAutoUpdateEnabled(): boolean {
  return getConfigValue('autoUpdate.enabled', true);
}

/** Persist `autoUpdate.enabled` without applying the setting to running components. */
export function setAutoUpdateEnabled(enabled: boolean): void {
  setConfigValue('autoUpdate.enabled', enabled);
}

/** Read `lastPageUrl`, returning undefined when the key is absent. */
export function getLastPageUrl(): string | undefined {
  return getConfigValueOptional('lastPageUrl');
}

/** Persist `lastPageUrl` without applying the setting to running components. */
export function setLastPageUrl(url: string): void {
  setConfigValue('lastPageUrl', url);
}

/** Read `startPage`, defaulting to `'new'` when absent. */
export function getStartPage(): MusicStartPageId | 'last' {
  return getConfigValue('startPage', 'new');
}

/** Persist `startPage` without applying the setting to running components. */
export function setStartPage(page: MusicStartPageId | 'last'): void {
  setConfigValue('startPage', page);
}

/** Read `zoomFactor`, defaulting to `1.0` when absent. */
export function getZoomFactor(): number {
  return getConfigValue('zoomFactor', 1.0);
}

/** Persist `zoomFactor` without applying the setting to running components. */
export function setZoomFactor(factor: number): void {
  setConfigValue('zoomFactor', factor);
}

/** Read the stored service, falling back to the default for an unregistered id. */
export function getMusicService(): MusicServiceId {
  const id = getConfigValue('musicService', DEFAULT_SERVICE_ID);
  if (!isMusicServiceId(id)) {
    configLog.warn('musicService not registered:', id, '- falling back to:', DEFAULT_SERVICE_ID);
    return DEFAULT_SERVICE_ID;
  }
  return id;
}

/** Persist `musicService` without applying the setting to running components. */
export function setMusicService(id: MusicServiceId): void {
  setConfigValue('musicService', id);
}

/** Read `classical.startPage`, defaulting to `'home'` when absent. */
export function getClassicalStartPage(): ClassicalStartPageId | 'last' {
  return getConfigValue('classical.startPage', 'home');
}

/** Persist `classical.startPage` without applying the setting to running components. */
export function setClassicalStartPage(page: ClassicalStartPageId | 'last'): void {
  setConfigValue('classical.startPage', page);
}

/** Read `classical.lastPageUrl`, returning undefined when the key is absent. */
export function getClassicalLastPageUrl(): string | undefined {
  return getConfigValueOptional('classical.lastPageUrl');
}

/** Persist `classical.lastPageUrl` without applying the setting to running components. */
export function setClassicalLastPageUrl(url: string): void {
  setConfigValue('classical.lastPageUrl', url);
}

export function getClassicalLanguage(): string | null | undefined {
  return getConfigValueOptional('classical.language');
}

export function setClassicalLanguage(lang: string | null): void {
  setConfigValue('classical.language', lang);
}

/**
 * Map each service to its stored preferences without branching at call sites.
 * The total Record requires an entry for every registered service.
 */
const SERVICE_ACCESSORS: Record<MusicServiceId, {
  getStartPage: () => AnyStartPageId | 'last';
  getLastPageUrl: () => string | undefined;
  setLastPageUrl: (url: string) => void;
  getLanguage: () => string | null | undefined;
  setLanguage: (lang: string | null) => void;
}> = {
  music: {
    getStartPage,
    getLastPageUrl,
    setLastPageUrl,
    getLanguage,
    setLanguage,
  },
  classical: {
    getStartPage: getClassicalStartPage,
    getLastPageUrl: getClassicalLastPageUrl,
    setLastPageUrl: setClassicalLastPageUrl,
    getLanguage: getClassicalLanguage,
    setLanguage: setClassicalLanguage,
  },
};

/**
 * Read a service's stored start page with a union that covers both services.
 * Resolve the result against that service's startPages and default.
 */
export function getStartPageFor(id: MusicServiceId): AnyStartPageId | 'last' {
  return SERVICE_ACCESSORS[id].getStartPage();
}

/** Read the last page stored for the requested service. */
export function getLastPageUrlFor(id: MusicServiceId): string | undefined {
  return SERVICE_ACCESSORS[id].getLastPageUrl();
}

/** Persist the last page under the requested service. */
export function setLastPageUrlFor(id: MusicServiceId, url: string): void {
  SERVICE_ACCESSORS[id].setLastPageUrl(url);
}

export function getLanguageFor(id: MusicServiceId): string | null | undefined {
  return SERVICE_ACCESSORS[id].getLanguage();
}

export function setLanguageFor(id: MusicServiceId, lang: string | null): void {
  SERVICE_ACCESSORS[id].setLanguage(lang);
}

/** Quality preferences offered in Settings, best first. */
export const AUDIO_QUALITY_PREFERENCES = [
  'hi-res',
  'lossless',
  'atmos',
  'dolby-audio',
  'aac',
] as const;

export type AudioQualityPreference = (typeof AUDIO_QUALITY_PREFERENCES)[number];

/** Read `audio.enabled`, defaulting to `true`; the native pipeline is the point of Lidra. */
export function getAudioEnabled(): boolean {
  const env = envString('LIDRA_AUDIO_ENABLED');
  if (env !== undefined) return env !== '0' && env.toLowerCase() !== 'false';
  return getConfigValue('audio.enabled', true);
}

/** Persist whether the native audio pipeline replaces the page's DRM playback. */
export function setAudioEnabled(enabled: boolean): void {
  setConfigValue('audio.enabled', enabled);
}

/** Read `audio.quality`, defaulting to `'auto'` (best available). */
export function getAudioQuality(): AudioQualityPreference | 'auto' {
  const value = envString('LIDRA_AUDIO_QUALITY') ?? getConfigValue('audio.quality', 'auto');
  return (AUDIO_QUALITY_PREFERENCES as readonly string[]).includes(value)
    ? (value as AudioQualityPreference)
    : 'auto';
}

/** Persist the preferred minimum quality tier. */
export function setAudioQuality(quality: AudioQualityPreference | 'auto'): void {
  setConfigValue('audio.quality', quality);
}

/** Read `audio.keyTransport`; `socket` covers TCP and Unix sockets. */
export function getAudioKeyTransport(): 'socket' | 'http' {
  const value = envString('LIDRA_KEY_TRANSPORT') ?? getConfigValue('audio.keyTransport', 'socket');
  return value === 'http' ? 'http' : 'socket';
}

/** Persist the key service transport. */
export function setAudioKeyTransport(transport: 'socket' | 'http'): void {
  setConfigValue('audio.keyTransport', transport);
}

/** Read the key service address (`host:port`, `unix:/path`, or an http URL). */
export function getAudioKeyService(): string {
  return envString('LIDRA_KEY_SERVICE') ?? getConfigValue('audio.keyService', '');
}

/** Persist the key service address. */
export function setAudioKeyService(address: string): void {
  setConfigValue('audio.keyService', address);
}

/** Read the optional bearer token for an HTTP key service. */
export function getAudioKeyToken(): string | null | undefined {
  return envString('LIDRA_KEY_TOKEN') ?? getConfigValueOptional('audio.keyToken');
}

/** Persist the optional bearer token for an HTTP key service. */
export function setAudioKeyToken(token: string | null): void {
  setConfigValue('audio.keyToken', token);
}

/** Read an explicit ffmpeg path, or undefined to use PATH. */
export function getAudioFfmpegPath(): string | null | undefined {
  return envString('LIDRA_FFMPEG') ?? getConfigValueOptional('audio.ffmpegPath');
}

/** Persist an explicit ffmpeg path. */
export function setAudioFfmpegPath(path: string | null): void {
  setConfigValue('audio.ffmpegPath', path);
}

/** Read whether the EME shim is injected into the page. */
export function getAudioEmeShim(): boolean {
  return getConfigValue('audio.emeShim', true);
}

/** Persist the EME shim toggle. */
export function setAudioEmeShim(enabled: boolean): void {
  setConfigValue('audio.emeShim', enabled);
}

/** Read the wrapper decrypt-socket address, when that transport is used. */
export function getAudioDecryptorService(): string {
  return envString('LIDRA_DECRYPTOR') ?? getConfigValue('audio.decryptorService', '');
}

/** Persist the wrapper decrypt-socket address. */
export function setAudioDecryptorService(address: string): void {
  setConfigValue('audio.decryptorService', address);
}

/** Read the wrapper manifest-socket address, for manifests the API omits. */
export function getAudioManifestService(): string {
  return envString('LIDRA_MANIFEST_SERVICE') ?? getConfigValue('audio.manifestService', '');
}

/** Persist the wrapper manifest-socket address. */
export function setAudioManifestService(address: string): void {
  setConfigValue('audio.manifestService', address);
}
