import type { BrowserWindow } from "electron";
import * as config from "./config";
import { getLoadingText, getTrayStrings, type TrayStrings } from "./i18n";
import {
  MUSIC_SERVICES,
  allServices,
  isMusicServiceId,
  DEFAULT_SERVICE_ID,
  type AnyStartPageId,
  type MusicServiceId,
  type MusicStartPageId,
  type ClassicalStartPageId,
} from "./musicService";
import { BUNDLED_THEMES, type ThemeName } from "./palettes";
import { applyTheme, hasCustomTheme, resolveTheme } from "./theme";
import type { SpatialMode } from "./audio/hls";
import type { AudioQualityPreference } from "./config";
import { findFfmpeg } from "./audio/transcode";
import {
  enable as enableDiscord,
  disable as disableDiscord,
} from "./integrations/discord-presence";
import * as lastfm from "./integrations/lastfm";

/** Zoom levels that Settings accepts. */
export type ZoomFactor = 1 | 1.25 | 1.5 | 1.75 | 2;
/** Actions that Settings and tray controls accept after runtime validation. */
export type SettingsAction =
  | { type: "musicService"; value: MusicServiceId }
  | { type: "startPage"; serviceId: "music"; value: MusicStartPageId | "last" }
  | {
      type: "startPage";
      serviceId: "classical";
      value: ClassicalStartPageId | "last";
    }
  | { type: "theme"; value: ThemeName }
  | { type: "zoomFactor"; value: ZoomFactor }
  | {
      type: "closeToTray" | "notifications" | "discord" | "lastfmEnabled";
      value: boolean;
    }
  | { type: "audioEnabled"; value: boolean }
  | { type: "audioQuality"; value: AudioQualityPreference | "auto" }
  | { type: "audioSpatial"; value: SpatialMode }
  | { type: "audioDevice"; value: string }
  | { type: "audioDecryptor"; value: string }
  | { type: "audioManifest"; value: string }
  | { type: "audioWrapperCommand"; value: string }
  | { type: "audioWrapperAutostart"; value: boolean }
  | { type: "lastfmConnect" | "lastfmDisconnect" };

/** A stored option value paired with its display label. */
export interface SettingsOption<T> {
  value: T;
  label: string;
}
/** Current settings, available choices and translated labels for the renderer. */
export interface SettingsState {
  musicService: MusicServiceId;
  startPage: AnyStartPageId | "last";
  theme: ThemeName;
  zoomFactor: number;
  closeToTray: boolean;
  notifications: boolean;
  discord: boolean;
  audioEnabled: boolean;
  audioQuality: AudioQualityPreference | "auto";
  audioSpatial: SpatialMode;
  audioDevice: string;
  /** Wrapper decrypt socket; when set, ciphertext is decrypted by that service. */
  audioDecryptor: string;
  /** Wrapper manifest socket, used instead of the API's manifest when set. */
  audioManifest: string;
  /** Command line Lidra uses to start the FairPlay wrapper. */
  audioWrapperCommand: string;
  audioWrapperAutostart: boolean;
  /** Resolved ffmpeg path, or null when none is available. */
  audioFfmpeg: string | null;
  lastfm: {
    available: boolean;
    customEndpoint: boolean;
    connected: boolean;
    enabled: boolean;
    username: string;
  };
  options: {
    musicService: SettingsOption<MusicServiceId>[];
    startPage: SettingsOption<AnyStartPageId | "last">[];
    theme: SettingsOption<ThemeName>[];
    zoomFactor: SettingsOption<ZoomFactor>[];
    audioQuality: SettingsOption<AudioQualityPreference | "auto">[];
    audioSpatial: SettingsOption<SpatialMode>[];
  };
  labels: TrayStrings;
  lang: string;
}

/** Isolated preload API for the local Settings page. */
export interface WrapperSignInPayload {
  email: string;
  password: string;
  code: string;
}

export interface SettingsBridge {
  /** Read the current settings and available choices. */
  getState(): Promise<SettingsState>;
  /** Apply a validated action and return the resulting state. */
  apply(action: SettingsAction): Promise<SettingsState>;
  wrapperSignIn(payload: WrapperSignInPayload): Promise<{ state: string; detail: string }>;
  signOut(): Promise<void>;
  /** Subscribe to state changes and return an unsubscribe function. */
  onState(listener: (state: SettingsState) => void): () => void;
}

interface SettingsRuntime {
  getMainWindow: () => BrowserWindow | null;
  applyZoom: (factor: number) => void;
  switchService: (id: MusicServiceId) => void;
  refreshTray: () => void;
}

let runtime: SettingsRuntime | null = null;
const listeners = new Set<(state: SettingsState) => void>();

/** Connect application callbacks and Last.fm updates, returning their teardown function. */
export function initSettingsActions(callbacks: SettingsRuntime): () => void {
  runtime = callbacks;
  lastfm.setStateChangedCallback(() => {
    callbacks.refreshTray();
    notifySettingsChanged();
  });
  return () => {
    if (runtime !== callbacks) return;
    runtime = null;
    lastfm.setStateChangedCallback(null);
    listeners.clear();
  };
}

/** Map every service's start-page IDs to translated labels. */
export function startPageLabels(
  strings: TrayStrings,
): Record<AnyStartPageId | "last", string> {
  return {
    home: strings.startPageHome,
    new: strings.startPageNew,
    radio: strings.startPageRadio,
    "all-playlists": strings.startPageAllPlaylists,
    browse: strings.startPageBrowse,
    playlists: strings.startPagePlaylists,
    search: strings.startPageSearch,
    last: strings.startPageLast,
  };
}

/** Resolve stored settings against the active service and currently available options. */
export function getSettingsState(): SettingsState {
  const labels = getTrayStrings();
  const storedService = config.getMusicService();
  const musicService = isMusicServiceId(storedService)
    ? storedService
    : DEFAULT_SERVICE_ID;
  const service = MUSIC_SERVICES[musicService];
  const pageLabels = startPageLabels(labels);
  const pages: (AnyStartPageId | "last")[] = [
    ...service.startPages.map((page) => page.id),
    "last",
  ];
  const storedPage = config.getStartPageFor(musicService);
  const themes: SettingsOption<ThemeName>[] = [
    { value: "apple-music", label: labels.styleAppleMusic },
    ...BUNDLED_THEMES.map((theme) => ({
      value: theme.name,
      label: theme.label,
    })),
  ];
  if (hasCustomTheme())
    themes.push({ value: "custom", label: labels.styleCustom });
  return {
    musicService,
    startPage: pages.includes(storedPage)
      ? storedPage
      : service.defaultStartPage,
    theme: resolveTheme(),
    zoomFactor: config.getZoomFactor(),
    closeToTray: config.getCloseToTrayEnabled(),
    notifications: config.getNotificationsEnabled(),
    discord: config.getDiscordEnabled(),
    audioEnabled: config.getAudioEnabled(),
    audioQuality: config.getAudioQuality(),
    audioSpatial: config.getAudioSpatial(),
    audioDevice: config.getAudioWidevineDevice() ?? "",
    audioDecryptor: config.getAudioDecryptorService(),
    audioManifest: config.getAudioManifestService(),
    audioWrapperCommand: config.getAudioWrapperCommand(),
    audioWrapperAutostart: config.getAudioWrapperAutostart(),
    audioFfmpeg: findFfmpeg(config.getAudioFfmpegPath() ?? undefined),
    lastfm: {
      available: lastfm.isConfigured(),
      customEndpoint: lastfm.isCustomEndpoint(),
      connected: !lastfm.isCustomEndpoint() && !!config.getLastfmSessionKey(),
      enabled: config.getLastfmEnabled(),
      username: lastfm.isCustomEndpoint() ? "" : config.getLastfmUsername() ?? "",
    },
    options: {
      musicService: allServices().map((service) => ({
        value: service.id,
        label: service.displayName,
      })),
      startPage: pages.map((value) => ({ value, label: pageLabels[value] })),
      theme: themes,
      audioQuality: [
        { value: "auto", label: labels.qualityAuto },
        { value: "hi-res", label: labels.qualityHiRes },
        { value: "lossless", label: labels.qualityLossless },
        { value: "atmos", label: labels.qualityAtmos },
        { value: "dolby-audio", label: labels.qualityDolby },
        { value: "aac", label: labels.qualityAac },
      ],
      audioSpatial: [
        { value: "bed", label: labels.spatialBed },
        { value: "binaural", label: labels.spatialBinaural },
      ],
      zoomFactor: [
        { value: 1, label: labels.zoom100 },
        { value: 1.25, label: labels.zoom125 },
        { value: 1.5, label: labels.zoom150 },
        { value: 1.75, label: labels.zoom175 },
        { value: 2, label: labels.zoom200 },
      ],
    },
    labels,
    lang: getLoadingText().lang,
  };
}

/** Register a state listener and return its unsubscribe function. */
export function subscribeSettingsChanges(
  listener: (state: SettingsState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Send one freshly resolved state to all registered listeners. */
export function notifySettingsChanged(): void {
  if (!listeners.size) return;
  const state = getSettingsState();
  for (const listener of listeners) listener(state);
}

function isSettingsAction(
  action: unknown,
  state: SettingsState,
): action is SettingsAction {
  if (typeof action !== "object" || action === null || Array.isArray(action))
    return false;
  const data = action as Record<string, unknown>;
  const keys =
    data.type === "startPage"
      ? ["type", "value", "serviceId"]
      : data.type === "lastfmConnect" || data.type === "lastfmDisconnect"
        ? ["type"]
        : ["type", "value"];
  if (
    Object.keys(data).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(data, key))
  )
    return false;
  switch (data.type) {
    case "musicService":
      return state.options.musicService.some(
        (option) => option.value === data.value,
      );
    case "startPage":
      return (
        data.serviceId === state.musicService &&
        state.options.startPage.some((option) => option.value === data.value)
      );
    case "theme":
      return state.options.theme.some((option) => option.value === data.value);
    case "zoomFactor":
      return state.options.zoomFactor.some(
        (option) => option.value === data.value,
      );
    case "closeToTray":
    case "notifications":
    case "discord":
      return typeof data.value === "boolean";
    case "audioEnabled":
      return typeof data.value === "boolean";
    case "audioQuality":
      return state.options.audioQuality.some(
        (option) => option.value === data.value,
      );
    case "audioSpatial":
      return state.options.audioSpatial.some(
        (option) => option.value === data.value,
      );
    case "audioDevice":
      return typeof data.value === "string" && data.value.length <= 4096;
    case "audioDecryptor":
      return typeof data.value === "string" && data.value.trim().length <= 256;
    case "audioManifest":
      return typeof data.value === "string" && data.value.trim().length <= 256;
    case "audioWrapperCommand":
      return typeof data.value === "string" && data.value.trim().length <= 4096;
    case "audioWrapperAutostart":
      return typeof data.value === "boolean";
    case "lastfmEnabled":
      return (
        state.lastfm.available &&
        (state.lastfm.connected || state.lastfm.customEndpoint) &&
        typeof data.value === "boolean"
      );
    case "lastfmConnect":
      return state.lastfm.available && !state.lastfm.customEndpoint && !state.lastfm.connected;
    case "lastfmDisconnect":
      return state.lastfm.available && !state.lastfm.customEndpoint && state.lastfm.connected;
    default:
      return false;
  }
}

/** Validate an action against available choices, apply it and refresh the tray and Settings. */
export function applySettingsAction(action: unknown): SettingsState {
  const state = getSettingsState();
  if (!isSettingsAction(action, state))
    throw new Error("Invalid settings action");
  if (!runtime) throw new Error("Settings actions are not initialised");
  switch (action.type) {
    case "musicService":
      if (action.value !== state.musicService)
        runtime.switchService(action.value);
      break;
    case "startPage":
      if (action.serviceId === "music") config.setStartPage(action.value);
      else config.setClassicalStartPage(action.value);
      break;
    case "theme":
      config.setTheme(action.value);
      applyTheme(action.value);
      break;
    case "zoomFactor":
      config.setZoomFactor(action.value);
      runtime.applyZoom(action.value);
      break;
    case "closeToTray": {
      config.setCloseToTrayEnabled(action.value);
      const window = runtime.getMainWindow();
      if (!action.value && window && !window.isVisible()) {
        window.show();
        window.focus();
      }
      break;
    }
    case "notifications":
      config.setNotificationsEnabled(action.value);
      break;
    case "audioEnabled":
      config.setAudioEnabled(action.value);
      break;
    case "audioQuality":
      config.setAudioQuality(action.value);
      break;
    case "audioSpatial":
      config.setAudioSpatial(action.value);
      break;
    case "audioDevice":
      config.setAudioWidevineDevice(action.value.trim() ? action.value.trim() : null);
      break;
    case "audioDecryptor":
      config.setAudioDecryptorService(action.value.trim());
      break;
    case "audioManifest":
      config.setAudioManifestService(action.value.trim());
      break;
    case "audioWrapperCommand":
      config.setAudioWrapperCommand(action.value);
      break;
    case "audioWrapperAutostart":
      config.setAudioWrapperAutostart(action.value);
      break;
    case "discord":
      config.setDiscordEnabled(action.value);
      (action.value ? enableDiscord : disableDiscord)();
      break;
    case "lastfmEnabled":
      config.setLastfmEnabled(action.value);
      (action.value ? lastfm.enable : lastfm.disable)();
      break;
    case "lastfmConnect":
      config.setLastfmEnabled(true);
      lastfm.startAuth();
      break;
    case "lastfmDisconnect":
      lastfm.disconnect();
      break;
  }
  runtime.refreshTray();
  notifySettingsChanged();
  return getSettingsState();
}
