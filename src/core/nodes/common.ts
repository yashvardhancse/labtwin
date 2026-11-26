/** Result of a service call or action goal request, like rclpy's `accepted` flag. */
export interface Response {
  accepted: boolean;
  reason?: string;
}

export const accepted: Response = { accepted: true };
export const rejected = (reason: string): Response => ({ accepted: false, reason });

/**
 * Round for publishing. Keeps recordings compact and stable; `+ 0` turns −0
 * into 0 so values survive a JSON round trip unchanged.
 */
export const round = (value: number, decimals: 2 | 3 | 4): number => {
  const f = decimals === 2 ? 100 : decimals === 3 ? 1000 : 10000;
  return Math.round(value * f) / f + 0;
};
