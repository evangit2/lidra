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
}
