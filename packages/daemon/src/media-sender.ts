/**
 * Pictures and videos sent to a phone in pieces, a few at a time, one or two
 * files at a time.
 *
 * A whole picture or clip used to go as one message: megabytes of base64 in a
 * single relay frame. On 2026-10-20 the relay link dropped right after two such
 * sends (about 20 pictures at once at 14:18, an 8.2 MB video at 14:39), and the
 * relay then kept the daemon out for a minute and a half, so every phone went
 * offline. Pieces are small, and this sends only `WINDOW` of them ahead of what
 * the phone has confirmed (`media.ack`): a slow phone slows the transfer down
 * instead of the backlog piling up in the relay.
 *
 * The window alone was per file, though: on 2026-10-21 opening a chat with ~30
 * pictures put ~30 transfers on the wire at once, up to 120 pieces in flight,
 * and the link dropped under it. So only `MAX_ACTIVE` files are sent at a time
 * and the rest wait their turn, in the order asked for. A lost connection
 * cancels everything in flight or waiting: its pieces can never be confirmed,
 * and the phone asks again once it is back.
 */
import type { wire } from "@pew2/protocol";

interface Transfer {
  acked: number;
  wake?: () => void;
  fail?: (error: Error) => void;
  aborted?: Error;
}

export class MediaSender {
  /** Characters of base64 per piece: 256 KB on the wire. */
  static PART_CHARS = 256 * 1024;
  /** Pieces sent beyond what the phone has confirmed. */
  static WINDOW = 4;
  /** Files sent at once; the rest wait their turn. */
  static MAX_ACTIVE = 2;
  /** A phone that confirms nothing for this long is gone: the transfer stops. */
  static ACK_TIMEOUT_MS = 30_000;

  /** Transfers being sent: how many pieces the phone has confirmed, and who waits on more. */
  private readonly transfers = new Map<string, Transfer>();
  /** Transfers waiting for a turn, oldest first. */
  private readonly queue: { requestId: string; start: () => void; fail: (error: Error) => void }[] = [];
  private active = 0;

  /**
   * Send `dataUri`'s bytes as pieces, then the closing reply that names how many.
   *
   * Resolves with the number of pieces once the closing reply is sent, or with
   * undefined when the same request is already queued or being sent (the phone
   * asked twice; one answer serves both). Rejects when the phone stops
   * confirming or the connection is lost, after which nothing more is sent.
   *
   * @param close The `image` / `video` reply, without its bytes.
   */
  async send(
    requestId: string,
    dataUri: string,
    reply: (message: wire.MediaPart | Record<string, unknown>) => void,
    close: { t: "image" | "video"; uri: string; mimeType?: string },
  ): Promise<number | undefined> {
    if (this.transfers.has(requestId) || this.queue.some((waiting) => waiting.requestId === requestId)) return undefined;
    await this.turn(requestId);
    const comma = dataUri.indexOf(",");
    const base64 = dataUri.slice(comma + 1);
    const count = Math.max(1, Math.ceil(base64.length / MediaSender.PART_CHARS));
    const transfer: Transfer = { acked: 0 };
    this.transfers.set(requestId, transfer);
    try {
      for (let index = 0; index < count; index++) {
        while (index - transfer.acked >= MediaSender.WINDOW) await this.awaitAck(transfer);
        if (transfer.aborted) throw transfer.aborted;
        const data = base64.slice(index * MediaSender.PART_CHARS, (index + 1) * MediaSender.PART_CHARS);
        reply({ t: "media.part", requestId, index, count, data });
      }
      reply({ ...close, requestId, parts: count });
      return count;
    } finally {
      this.transfers.delete(requestId);
      this.active -= 1;
      this.queue.shift()?.start();
    }
  }

  /** The phone has this many pieces of the request, in order. */
  ack(requestId: string, received: number) {
    const transfer = this.transfers.get(requestId);
    if (!transfer || received <= transfer.acked) return;
    transfer.acked = received;
    transfer.wake?.();
  }

  /**
   * Cancel everything being sent or waiting: the connection it was for is gone.
   * Each cancelled request ends with `reason`, which reaches nobody (the socket
   * is gone) but is what the log says.
   */
  abortAll(reason: string) {
    const error = new Error(reason);
    for (const waiting of this.queue.splice(0)) waiting.fail(error);
    for (const transfer of this.transfers.values()) {
      transfer.aborted = error;
      transfer.fail?.(error);
    }
  }

  /** Files being sent and waiting, for tests and the log. */
  load(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }

  private turn(requestId: string): Promise<void> {
    if (this.active < MediaSender.MAX_ACTIVE) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestId,
        start: () => {
          this.active += 1;
          resolve();
        },
        fail: reject,
      });
    });
  }

  private awaitAck(transfer: Transfer): Promise<void> {
    if (transfer.aborted) return Promise.reject(transfer.aborted);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        transfer.wake = undefined;
        transfer.fail = undefined;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error("The phone stopped confirming the download. Tap to try again."));
      }, MediaSender.ACK_TIMEOUT_MS);
      transfer.wake = () => {
        done();
        resolve();
      };
      transfer.fail = (error) => {
        done();
        reject(error);
      };
    });
  }
}
