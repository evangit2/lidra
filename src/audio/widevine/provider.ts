/**
 * KeyProvider backed by the Widevine licence exchange.
 *
 * Drop-in for the socket/HTTP key services: given a playlist key URI and a song
 * id, it returns the 16-byte content key Lidra's decryptor needs. Credentials
 * are read per request because Apple rotates the developer token within a
 * session.
 */
import log from "electron-log/main";
import type { KeyProvider, KeyRequest } from "../keys";
import { KeyError } from "../keys";
import { acquireContentKey, type LicenseCredentials } from "./license";
import { loadDeviceSpec, DeviceError, type WidevineDevice } from "./device";

const providerLog = log.scope("audio.widevine.provider");

export class WidevineKeyProvider implements KeyProvider {
  readonly name = "widevine";

  constructor(
    private readonly device: WidevineDevice,
    private readonly getCredentials: () => LicenseCredentials | null,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async getKey(request: KeyRequest): Promise<Buffer> {
    const credentials = this.getCredentials();
    if (!credentials) {
      throw new KeyError("Widevine licence needs a signed-in Apple Music session");
    }
    try {
      providerLog.info(`requesting licence for ${request.adamId}`);
      return await acquireContentKey({
        device: this.device,
        credentials,
        adamId: request.adamId,
        keyUri: request.keyUri,
        storefront: request.storefront,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      throw new KeyError(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Build a provider from a device spec (`.wvd` file or directory holding
 * `client_id.bin` + `private_key.pem`). Returns null when unconfigured so the
 * caller can fall back to another key source.
 */
export function createWidevineProvider(
  spec: string | undefined,
  getCredentials: () => LicenseCredentials | null,
  fetchImpl?: typeof fetch,
): WidevineKeyProvider | null {
  const trimmed = spec?.trim();
  if (!trimmed) return null;
  try {
    const device = loadDeviceSpec(trimmed);
    return new WidevineKeyProvider(device, getCredentials, fetchImpl);
  } catch (error) {
    if (error instanceof DeviceError) {
      providerLog.error(`device rejected: ${error.message}`);
      return null;
    }
    throw error;
  }
}
