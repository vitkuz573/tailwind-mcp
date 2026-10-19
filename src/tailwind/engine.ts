/**
 * Engine selection.
 *
 * One engine per project. The engine is rebuilt when the project's Tailwind
 * version changes; within a version the engine itself watches the config and
 * reloads on its own.
 */

import type { TailwindEngine } from "../core/types.js";
import { resolveProject, type ResolvedProject } from "./project.js";
import { V3Engine } from "./v3.js";
import { V4Engine } from "./v4.js";

export interface EngineHolder {
  readonly project: ResolvedProject;
  readonly engine: TailwindEngine;
}

/**
 * Build an engine for the project that contains `startDir`.
 *
 * @param startDir directory to resolve the project from
 */
export async function createEngine(startDir: string): Promise<EngineHolder> {
  const project = await resolveProject(startDir);
  const engine = project.install.major >= 4 ? new V4Engine({ project }) : new V3Engine({ project });
  return { project, engine };
}

export { resolveProject } from "./project.js";
export type { ResolvedProject } from "./project.js";
