/**
 * `node clean-docker.ts <app>`: Docker's cleanup (prune's `images`: Laru's unused images and volumes, the build cache
 * down to its cap) in a process of its own, so the command that triggered it (`laru test`, `laru up`) exits at once.
 * That part reads only the app's name.
 */
import type { Workspace } from '@laru/core';
import { prune } from './disk.ts';

await prune({ app: process.argv[2], root: '', repos: [] } as unknown as Workspace, { what: ['images'] }).catch(() => undefined);
