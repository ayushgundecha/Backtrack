/** Writes graph/queries.cypher from the query definitions. Run: pnpm gen:queries */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCatalogue } from '../src/graph/catalogue.js';
import { registry } from '../src/graph/queries.js';

const target = resolve(import.meta.dirname, '../../../graph/queries.cypher');
writeFileSync(target, renderCatalogue());
console.log(`wrote ${registry.length} queries to ${target}`);
