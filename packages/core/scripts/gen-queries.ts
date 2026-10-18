/** Writes graph/queries.cypher and the README's query blocks from the definitions. Run: pnpm gen:queries */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCatalogue, spliceReadme } from '../src/graph/catalogue.js';
import { registry } from '../src/graph/queries.js';

const root = resolve(import.meta.dirname, '../../..');
const cypherFile = resolve(root, 'graph/queries.cypher');
writeFileSync(cypherFile, renderCatalogue());
console.log(`wrote ${registry.length} queries to ${cypherFile}`);

const readme = resolve(root, 'README.md');
writeFileSync(readme, spliceReadme(readFileSync(readme, 'utf8')));
console.log(`updated the query blocks in ${readme}`);
