/**
 * Pictures and videos sent to a phone in pieces, a few at a time.
 *
 * A whole picture or clip used to go as one message: megabytes of base64 in a
 * single relay frame. On 2026-10-20 the relay link dropped right after two such
 * sends (about 20 pictures at once at 14:18, an 8.2 MB video at 14:39), and the
 * relay then kept the daemon out for a minute and a half, so every phone went
 * offline. Pieces are small, and this sends only `WINDOW` of them ahead of what
 * the phone has confirmed (`media.ack`): a slow phone slows the transfer down
 * instead of the backlog piling up in the relay.
 */
import type { wire } from "@pew2/protocol";

export class MediaSender {
  /** Characters of base64 per piece: 256 KB on the wire. */
  static PART_CHARS = 256 * 1024;
  /** Pieces sent beyond what the phone has confirmed. */
  static WINDOW = 4;
  /** A phone that confirms nothing for this long is gone: the transfer stops. */
  static ACK_TIMEOUT_MS = 30_000;

  /** Transfers in flight: how many pieces the phone has confirmed, and who waits on more. */
  private readonly transfers = new Map<string, { acked: number; wake?: () => void }>();

  /**
   * Send `dataUri`'s bytes as pieces, then the closing reply that names how many.
   *
   * Resolves once the closing reply is sent. Rejects when the phone stops
   * confirming, after which nothing more is sent for this request.
   *
   * @param close The `image` / `video` reply, without its bytes.
   */
  async send(
    requestId: string,
    dataUri: string,
    reply: (message: wire.MediaPart | Record<string, unknown>) => void,
    close: { t: "image" | "video"; uri: string; mimeType?: string },
  ): Promise<number> {
    const comma = dataUri.indexOf(",");
    const base64 = dataUri.slice(comma + 1);
    const count = Math.max(1, Math.ceil(base64.length / MediaSender.PART_CHARS));
    const transfer: { acked: number; wake?: () => void } = { acked: 0 };
    this.transfers.set(requestId, transfer);
    try {
      for (let index = 0; index < count; index++) {
        while (index - transfer.acked >= MediaSender.WINDOW) await this.awaitAck(transfer);
        const data = base64.slice(index * MediaSender.PART_CHARS, (index + 1) * MediaSender.PART_CHARS);
        reply({ t: "media.part", requestId, index, count, data });
      }
      reply({ ...close, requestId, parts: count });
      return count;
    } finally {
      this.transfers.delete(requestId);
    }
  }

  /** The phone has this many pieces of the request, in order. */
  ack(requestId: string, received: number) {
    const transfer = this.transfers.get(requestId);
    if (!transfer || received <= transfer.acked) return;
    transfer.acked = received;
    transfer.wake?.();
  }

  private awaitAck(transfer: { acked: number; wake?: () => void }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        transfer.wake = undefined;
        reject(new Error("The phone stopped confirming the download. Tap to try again."));
      }, MediaSender.ACK_TIMEOUT_MS);
      transfer.wake = () => {
        clearTimeout(timer);
        transfer.wake = undefined;
        resolve();
      };
    });
  }
}
