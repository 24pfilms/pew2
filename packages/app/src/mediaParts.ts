/**
 * Pictures and videos that arrive in pieces (`media.part`), put back together.
 *
 * The daemon sends a few pieces ahead of what this phone has confirmed, so each
 * piece is answered with how many have arrived in order; the closing `image` /
 * `video` reply then says how many there were, and the pieces become the
 * `data:` URI the viewers already take. No React, no Expo: tested under bun.
 */

interface Transfer {
  count: number;
  pieces: (string | undefined)[];
  /** Pieces held in order from the first: what the daemon is told. */
  contiguous: number;
}

export class MediaAssembly {
  private readonly transfers = new Map<string, Transfer>();

  /** Hold one piece. Returns how many have now arrived in order, to confirm. */
  add(part: { requestId: string; index: number; count: number; data: string }): number {
    let transfer = this.transfers.get(part.requestId);
    if (!transfer) {
      transfer = { count: part.count, pieces: new Array<string | undefined>(part.count), contiguous: 0 };
      this.transfers.set(part.requestId, transfer);
    }
    if (part.index >= 0 && part.index < transfer.count) transfer.pieces[part.index] = part.data;
    while (transfer.contiguous < transfer.count && transfer.pieces[transfer.contiguous] !== undefined) {
      transfer.contiguous += 1;
    }
    return transfer.contiguous;
  }

  /**
   * The whole, as a `data:` URI, once the closing reply names how many pieces
   * there were. Undefined when any is missing (a dropped connection took it).
   * Either way the pieces are let go.
   */
  finish(requestId: string, parts: number, mimeType: string | undefined): string | undefined {
    const transfer = this.transfers.get(requestId);
    this.transfers.delete(requestId);
    if (!transfer || transfer.count !== parts || transfer.contiguous !== parts) return undefined;
    return `data:${mimeType ?? "application/octet-stream"};base64,${transfer.pieces.join("")}`;
  }

  /** Drop everything half-received: the connection that was carrying it is gone. */
  clear() {
    this.transfers.clear();
  }
}
