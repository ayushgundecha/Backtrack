#!/usr/bin/env node
// @backtrack/core ships TypeScript sources; tsx compiles them on the fly, so there is no build step.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
