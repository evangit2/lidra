export interface SampleEncryption {
  scheme: "cbcs" | "cenc" | "cbc1";
  defaultKid: Buffer;
  perSampleIvSize: number;
  constantIv: Buffer | null;
  cryptByteBlock: number;
  skipByteBlock: number;
  originalFormat: string;
}

export interface InitInfo {
  trackId: number;
  encryption: SampleEncryption;
}

export interface SegmentSample {
  offset: number;
  size: number;
  iv: Buffer | null;
  subsamples: { clear: number; encrypted: number }[] | null;
}

export interface AesBackend {
  decrypt(data: Buffer, iv: Buffer): Buffer;
  /**
   * AES-CTR decryption of a run starting `offset` bytes into the sample.
   * `cenc` uses one keystream per sample, so the position matters and runs do
   * not have to be block aligned.
   */
  decryptCtr?(data: Buffer, iv: Buffer, offset: number): Buffer;
}
