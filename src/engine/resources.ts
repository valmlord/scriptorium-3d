/**
 * Everything a room allocates on the GPU, in one place, so that unloading it
 * is a single call rather than a list somebody has to keep in step.
 *
 * `docs/architecture.md` §3: textures and geometries are disposed when a room
 * is unloaded, because WebGL memory is not garbage collected. Dropping the
 * last reference to a `BufferGeometry` frees the JavaScript object and leaves
 * its vertex buffer resident on the device — the leak is invisible to the
 * profiler that would normally find it, and it is per room entered.
 *
 * A registry rather than a `dispose()` on each builder that remembers its own
 * resources: the builders are where a resource is easy to forget, and a count
 * of what was created is the only thing a test can hold against a count of
 * what was released.
 */

/** Anything holding device memory: a geometry, a material, a texture, a mesh. */
export interface DisposableResource {
  dispose(): void;
}

/** Collects disposables as they are created and releases them exactly once. */
export class ResourceRegistry {
  #tracked: DisposableResource[] = [];

  /** Record a resource and hand it straight back, so a builder reads as one expression. */
  track<T extends DisposableResource>(resource: T): T {
    this.#tracked.push(resource);
    return resource;
  }

  /** How many resources are held and not yet released. */
  get size(): number {
    return this.#tracked.length;
  }

  /** The resources held, for a caller that needs to count them by kind. */
  get tracked(): readonly DisposableResource[] {
    return this.#tracked;
  }

  /**
   * Release everything held, in the reverse of the order it was created, and
   * forget it. Idempotent: the list is cleared first, so a second call — an
   * unload racing a teardown — disposes nothing twice.
   */
  disposeAll(): void {
    const held = this.#tracked;
    this.#tracked = [];
    for (let index = held.length - 1; index >= 0; index -= 1) {
      held[index]?.dispose();
    }
  }
}
