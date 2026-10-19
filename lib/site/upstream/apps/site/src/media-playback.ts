export type MediaPlayback = {
  isLoading(): boolean;
  isPlaying(): boolean;
  duration(): number;
  currentTime(): number;
  toggle(): Promise<void>;
  seek(seconds: number): Promise<void>;
  subscribe(listener: () => void): () => void;
};

export type MediaPlaybackController = {
  controls: MediaPlayback;
  destroy(): void;
};

type MediaPlaybackControllerOptions = {
  createElement: () => Promise<HTMLMediaElement | undefined>;
  destroyElement: (element: HTMLMediaElement) => void;
  durationFallback?: number;
  initialTime?: number;
};

const MEDIA_EVENTS = [
  "canplay", "durationchange", "ended", "loadedmetadata", "pause", "play", "seeked", "timeupdate",
] as const;

export function createMediaPlaybackController(options: MediaPlaybackControllerOptions): MediaPlaybackController {
  const listeners = new Set<() => void>();
  const cancelWaits = new Set<() => void>();
  let element: HTMLMediaElement | undefined;
  let loading: Promise<HTMLMediaElement | undefined> | undefined;
  let seeking: Promise<void> | undefined;
  let targetTime: number | undefined = Math.max(0, options.initialTime ?? 0);
  let requestedPlaying = false;
  let destroyed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onMediaEvent = (event: Event) => {
    if (event.type === "ended") {
      requestedPlaying = false;
      targetTime = undefined;
    }
    notify();
  };
  // Register before load/currentTime so even a fast media event cannot be missed.
  const waitFor = (next: HTMLMediaElement, eventName: string) => {
    let cancel: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        next.removeEventListener(eventName, done);
        next.removeEventListener("error", fail);
        cancelWaits.delete(cancel);
      };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(next.error?.message || "媒体加载失败")); };
      cancel = done;
      cancelWaits.add(cancel);
      next.addEventListener(eventName, done);
      next.addEventListener("error", fail);
    });
    return { promise, cancel: () => cancel() };
  };
  const releaseElement = () => {
    for (const cancel of cancelWaits) cancel();
    if (!element) return;
    const previous = element;
    element = undefined;
    for (const eventName of MEDIA_EVENTS) previous.removeEventListener(eventName, onMediaEvent);
    options.destroyElement(previous);
  };
  const ensureElement = async () => {
    if (destroyed) return undefined;
    if (loading) return loading;
    if (element) return element;
    loading = (async () => {
      const next = await options.createElement();
      if (!next) return undefined;
      if (destroyed) {
        options.destroyElement(next);
        return undefined;
      }
      element = next;
      for (const eventName of MEDIA_EVENTS) next.addEventListener(eventName, onMediaEvent);
      if (next.readyState < 1) {
        const ready = waitFor(next, "loadedmetadata");
        next.load();
        await ready.promise;
      }
      return destroyed ? undefined : next;
    })().catch((error) => {
      releaseElement();
      throw error;
    }).finally(() => {
      loading = undefined;
      notify();
    });
    notify();
    return loading;
  };
  const applyTarget = async () => {
    if (seeking) return seeking;
    seeking = Promise.resolve().then(async () => {
      const next = await ensureElement();
      if (!next) return;
      while (!destroyed && targetTime !== undefined) {
        const requested = targetTime;
        // Keep a paused seek just before the end so it previews instead of firing ended.
        const max = Number.isFinite(next.duration) && next.duration > 0 ? Math.max(0, next.duration - 0.05) : requested;
        const seconds = Math.min(requested, max);
        targetTime = seconds;
        if (next.currentTime !== seconds || next.seeking) {
          const settled = waitFor(next, "seeked");
          try {
            next.currentTime = seconds;
          } catch (error) {
            settled.cancel();
            throw error;
          }
          await settled.promise;
        }
        // A drag may have queued a newer target while the previous frame loaded.
        if (targetTime === seconds) targetTime = undefined;
      }
    }).catch((error) => {
      releaseElement();
      throw error;
    }).finally(() => {
      seeking = undefined;
      notify();
    });
    return seeking;
  };

  const settleTarget = async () => {
    do {
      await applyTarget();
    } while (!destroyed && element && (seeking || targetTime !== undefined));
  };

  const controls: MediaPlayback = {
    isLoading: () => Boolean(loading),
    isPlaying: () => Boolean(element && !element.paused && !element.ended),
    duration: () => element && Number.isFinite(element.duration) && element.duration > 0 ? element.duration : options.durationFallback ?? 0,
    currentTime: () => targetTime ?? (element?.ended ? 0 : element?.currentTime ?? 0),
    toggle: async () => {
      if (destroyed) return;
      if (requestedPlaying || controls.isPlaying()) {
        requestedPlaying = false;
        element?.pause();
        notify();
        return;
      }
      requestedPlaying = true;
      notify();
      try {
        await settleTarget();
        if (destroyed || !element || !requestedPlaying) {
          requestedPlaying = false;
          return;
        }
        if (element.ended) {
          targetTime = 0;
          await settleTarget();
        }
        if (destroyed || !requestedPlaying) return;
        await element.play();
        if (!requestedPlaying || destroyed) element?.pause();
      } catch (error) {
        requestedPlaying = false;
        throw error;
      } finally {
        notify();
      }
    },
    seek: async (seconds) => {
      if (destroyed || !Number.isFinite(seconds)) return;
      const duration = controls.duration();
      targetTime = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      notify();
      await applyTarget();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    controls,
    destroy: () => {
      destroyed = true;
      requestedPlaying = false;
      releaseElement();
      listeners.clear();
    },
  };
}
