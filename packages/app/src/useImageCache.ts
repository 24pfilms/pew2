/**
 * The desktop-image cache behind `useDaemon`: pictures the daemon has been
 * asked to read off the desktop's disk, the byte-capped LRU that bounds them,
 * and the request guard that must always move with it. See `imageCache.ts`.
 */
import { useCallback, useRef, useState } from "react";
import { emptyImageCache, loadingUris, putImage, type ImageCache } from "./imageCache";
import type { ImageEntry } from "./daemonTypes";

export function useImageCache() {
  // Pictures the daemon has been asked to read off the desktop's disk, keyed by
  // the path the agent named. Outside State because it is a cache belonging to
  // this device's viewport, not to the conversation: it is never replayed,
  // never mirrored into history, and a resumed thread re-requests what it can
  // actually see. Inline `data:` sources never enter here at all.
  const [images, setImages] = useState<Record<string, ImageEntry>>({});
  // The same pictures, plus the recency and byte accounting that bounds them.
  //
  // The ref is the source of truth and state is its published copy: eviction has
  // to drop the uri from `requestedImages` as well, and a `setImages` updater is
  // the one place that must not do it — React may run an updater twice, and
  // mutating a ref in one is exactly the impurity `sessionRef` exists to avoid.
  const imagesCache = useRef<ImageCache<ImageEntry>>(emptyImageCache<ImageEntry>());
  // Images already asked for. A ref, not the state map: the request has to be
  // deduped at the moment of asking, which happens outside any updater.
  const requestedImages = useRef(new Set<string>());

  /**
   * Record one image, evicting whatever no longer fits.
   *
   * Both maps move together, always. `requestedImages` is the guard that stops
   * the transcript re-asking for a picture it already has, so an entry evicted
   * from the cache but left in the guard is a picture that can never be fetched
   * again — a spinner for the rest of the app's life. `ChatImage` re-requests on
   * every mount and cells recycle, so forgetting both is all a re-scroll needs.
   */
  const storeImage = useCallback((uri: string, entry: ImageEntry) => {
    const { cache, evicted } = putImage(imagesCache.current, uri, entry);
    imagesCache.current = cache;
    for (const gone of evicted) requestedImages.current.delete(gone);
    setImages(cache.images);
  }, []);

  /**
   * Drop every cached picture.
   *
   * For the moments where the pictures stop being about anything on screen:
   * leaving a conversation, switching agent, losing the pairing. Holding tens of
   * megabytes for a transcript nobody is looking at is the leak this cache
   * exists to stop.
   */
  const clearImages = useCallback(() => {
    imagesCache.current = emptyImageCache<ImageEntry>();
    requestedImages.current.clear();
    setImages({});
  }, []);

  /** One picture's entry as it stands now, read from the source of truth. */
  const imageEntry = useCallback((uri: string): ImageEntry | undefined => imagesCache.current.images[uri], []);

  /**
   * Pictures still waiting on an answer.
   *
   * A request rides one socket: when that socket is replaced, its answer is
   * gone with it, and a picture left "loading" would spin for the rest of the
   * app's life — the guard above stops it ever being asked for again. These
   * are what a new connection re-asks for.
   */
  const loadingImages = useCallback((): string[] => loadingUris(imagesCache.current), []);

  return { images, requestedImages, storeImage, clearImages, imageEntry, loadingImages };
}
