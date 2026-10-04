import type { ExifInfo } from './exif';

export type Format = 'jpeg' | 'png' | 'webp';
export type Mode = 'location' | 'all';

/** 写真の中身を調べた結果。 */
export interface Report extends ExifInfo {
  format: Format;
  /** XMP の中に位置情報があるか。 */
  gpsInXmp: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  hasComment: boolean;
  hasIcc: boolean;
}

/** 位置情報が（EXIF か XMP に）残っているか。 */
export const hasLocation = (r: Report): boolean => r.gps !== null || r.hasGpsIfd || r.gpsInXmp;

export class PhotoError extends Error {
  constructor(readonly code: 'heic' | 'unsupported' | 'broken', message: string) {
    super(message);
  }
}
