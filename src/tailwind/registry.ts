/**
 * Project registry.
 *
 * The server can be installed globally, so it may be asked about any project
 * in any session. Engines are therefore cached per project root, and each
 * one reloads its own configuration when the files behind it change.
 */

import { createEngine, type EngineHolder } from "./engine.js";
import type { Logger } from "../core/logger.js";

export class ProjectRegistry {
  private readonly cache = new Map<string, EngineHolder>();
  private readonly pending = new Map<string, Promise<EngineHolder>>();

  constructor(private readonly logger: Logger) {}

  /**
   * Get the engine for a project.
   *
   * @param projectRoot directory the project is resolved from
   */
  async get(projectRoot: string): Promise<EngineHolder> {
    const key = projectRoot;

    const cached = this.cache.get(key);
    if (cached) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = createEngine(projectRoot)
      .then((holder) => {
        this.cache.set(key, holder);
        this.pending.delete(key);
        this.logger.info("engine.ready", {
          project: holder.project.root,
          version: holder.project.install.version,
          generation: holder.engine.version,
          source: holder.engine.source,
        });
        return holder;
      })
      .catch((error: unknown) => {
        this.pending.delete(key);
        throw error;
      });

    this.pending.set(key, promise);
    return promise;
  }
}
