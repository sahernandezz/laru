/** The physical model reads the repositories' own DDL: columns with their keys, and the foreign keys between the tables. */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDdl } from '../src/knowledge/derive.ts';

test('CREATE TABLE statements give the columns, their keys and what they reference; comments, indexes and other folders are left out', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ks-ddl-'));
  mkdirSync(join(repo, 'infra'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'x', 'bad.sql'), 'CREATE TABLE nope.t (id INT);');
  writeFileSync(join(repo, 'infra', 'init.sql'), `
-- the shop
CREATE TABLE shop.orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES shop.customers(id) ON DELETE CASCADE,
    total       NUMERIC(10, 2) NOT NULL DEFAULT 0, -- in cents
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_orders_customer ON shop.orders(customer_id);
CREATE TABLE IF NOT EXISTS shop.customers (
    id   UUID PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    CONSTRAINT uq_name UNIQUE (name)
);`);
  const ddl = readDdl({ checkouts: { shop: repo } } as never);
  assert.deepEqual([...ddl.keys()].sort(), ['shop.customers', 'shop.orders']);
  assert.deepEqual(ddl.get('shop.orders')!.columns, ['id UUID PK', 'customer_id UUID FK', 'total NUMERIC(10, 2)', 'created_at TIMESTAMPTZ']);
  assert.deepEqual(ddl.get('shop.orders')!.refs, [{ column: 'customer_id', table: 'shop.customers' }]);
  assert.deepEqual(ddl.get('shop.customers')!.columns, ['id UUID PK', 'name VARCHAR(80)']);
});
