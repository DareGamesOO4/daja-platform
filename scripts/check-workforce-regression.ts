import assert from 'node:assert/strict';
import pg from 'pg';
import { workforceProducts, workforceSummary, workforceTimelineEntries } from '../apps/api/src/workforce-data.js';
import { workforceDashboard } from '../apps/api/src/workforce-sessions.js';
if (!process.env.WORKFORCE_TEST_DATABASE_URL) throw new Error('Set WORKFORCE_TEST_DATABASE_URL explicitly. Fixtures use only temporary tables and roll back.');
const db = new pg.Client({connectionString: process.env.WORKFORCE_TEST_DATABASE_URL});
await db.connect();
try {
await db.query('BEGIN');
await db.query("SET LOCAL search_path=pg_temp; SET LOCAL statement_timeout='15s'");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.query(`
CREATE TEMP TABLE users(id uuid,organization_id uuid,display_name text,email text);
CREATE TEMP TABLE products(id uuid,organization_id uuid,created_by_user_id uuid,name text,slug text,description text,department_id uuid,brand_id uuid,primary_category_id uuid,features jsonb DEFAULT '[]',quality_review_status text DEFAULT 'pending',quality_review_note text,compensation_amount_minor int,compensation_approved_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
CREATE TEMP TABLE product_variants(id uuid,organization_id uuid,product_id uuid,sku text,barcode text,gender text,current_price_amount int,attributes jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),deleted_at timestamptz);
CREATE TEMP TABLE inventory_balances(organization_id uuid,variant_id uuid,location_id uuid,quantity int,updated_at timestamptz DEFAULT now());
CREATE TEMP TABLE product_media(id uuid,organization_id uuid,product_id uuid,media_asset_id uuid,is_primary bool,position int);
CREATE TEMP TABLE media_assets(id uuid,status text,public_url text);
CREATE TEMP TABLE media_derivatives(media_asset_id uuid,public_url text,width int);
CREATE TEMP TABLE departments(id uuid,organization_id uuid,name text);
CREATE TEMP TABLE brands(id uuid,organization_id uuid,name text);
CREATE TEMP TABLE categories(id uuid,organization_id uuid,name text);
CREATE TEMP TABLE audit_events(id uuid,organization_id uuid,actor_user_id uuid,aggregate_type text,aggregate_id uuid,operation text,request_id text,occurred_at timestamptz DEFAULT now(),before_payload jsonb,after_payload jsonb,reason text);
CREATE TEMP TABLE catalog_contributor_rates(organization_id uuid,user_id uuid,rate_minor int);
CREATE TEMP TABLE catalog_contributor_settings(organization_id uuid,default_rate_minor int);
CREATE TEMP TABLE catalog_contributor_rate_rules(organization_id uuid,user_id uuid,department_id uuid,brand_id uuid,category_id uuid,rate_minor int);
CREATE TEMP TABLE roles(id uuid,organization_id uuid,code text,deleted_at timestamptz);
CREATE TEMP TABLE user_role_assignments(organization_id uuid,user_id uuid,role_id uuid,deleted_at timestamptz);
CREATE TEMP TABLE catalog_work_sessions(id uuid,organization_id uuid,user_id uuid,product_id uuid,kind text,status text,complete bool,started_at timestamptz,finished_at timestamptz,active_seconds int);
`);
await db.query(`INSERT INTO users VALUES($1,$2,'Worker','worker@test'),($3,$2,'Other worker','other@test'),($4,$5,'Other tenant','tenant@test')`,[id(10),id(1),id(11),id(12),id(2)]);
await db.query(`INSERT INTO products(id,organization_id,created_by_user_id,name,slug,created_at,department_id,brand_id,primary_category_id) VALUES($1,$2,$3,'Watch','watch','2026-10-27T08:00:00Z',$4,$4,$4),($5,$2,$3,'Deleted','deleted','2026-10-27T09:00:00Z',$4,$4,$4),($6,$7,$8,'Private','private','2026-10-27T08:00:00Z',$4,$4,$4)`,[id(100),id(1),id(10),id(20),id(101),id(102),id(2),id(12)]);
await db.query('UPDATE products SET deleted_at=now() WHERE id=$1',[id(101)]);
await db.query(`INSERT INTO product_variants(id,organization_id,product_id,sku) VALUES($1,$2,$3,'FIRST'),($4,$2,$3,'SECOND')`,[id(200),id(1),id(100),id(201)]);
await db.query('INSERT INTO catalog_contributor_settings VALUES($1,12500)',[id(1)]);
for (const [n,type,aggregate,operation,request,time] of [
 [300,'product',100,'create','save-1','08:00'],[301,'variant',200,'create','save-1','08:00'],[302,'inventory_balance',200,'adjust','save-1','08:00'],
 [303,'product',100,'update','save-2','10:00'],[304,'variant',200,'update','save-2','10:00'],[305,'inventory_balance',200,'adjust','save-2','10:00'],
 [306,'product',100,'update','save-3','11:00'],[307,'product',100,'quality_changes_requested','save-3','11:00'],
 [308,'variant',200,'price_change','save-4','12:00']
]) await db.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,aggregate_type,aggregate_id,operation,request_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id(n),id(1),id(10),type,id(aggregate),operation,request,`2026-10-27T${time}:00Z`]);
const products=await workforceProducts(db,id(1),id(10));
assert.equal(products.length,2,'one row per product even with multiple variants');
assert.equal(products.find(p=>p.id===id(100)).qualityChecks.length,13);
assert.equal(products.find(p=>p.id===id(100)).effectiveRateMinor,12500);
assert.deepEqual(products.find(p=>p.id===id(101)).qualityMissing,[]);
assert.equal((await workforceProducts(db,id(2),id(10))).length,0,'tenant isolation');
const summary=await workforceSummary(db,id(1),'2026-10-01','2026-11-01',id(10));
assert.equal(summary.length,1);assert.equal(summary[0].createdTotal,2);assert.equal(summary[0].deletedCount,1);
const events=await workforceTimelineEntries(db,id(1),id(10),'2026-10-27');
assert.equal(events.length,5,'two creations, one edit, one review, one independent price change');
assert.equal(events.filter(e=>e.operation==='created').length,2);
assert.equal(events.filter(e=>e.operation==='quality_changes_requested').length,1);
assert.equal((await workforceTimelineEntries(db,id(2),id(10),'2026-10-27')).length,0);
const dashboard=await workforceDashboard(db,id(1),id(10),{date:'2026-10-27',startHour:0,hours:24});
assert.equal(dashboard.daily.length,90);assert.equal(dashboard.daily.at(-1).count,2);assert.equal(dashboard.team.length,1);
assert.equal((await workforceTimelineEntries(db,id(1),id(10),'2026-10-26')).length,0);
await db.query(`INSERT INTO products(id,organization_id,created_by_user_id,name,slug) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,$2,'Bulk watch','bulk-'||n FROM generate_series(1000,1799) n`,[id(1),id(10)]);
const bulk=await workforceProducts(db,id(1),id(10));
assert.equal(bulk.length,802,'large employee catalog loads in one query');
assert.equal(new Set(bulk.map(p=>p.id)).size,802);
console.log('PASS: real PostgreSQL queries: batch quality, variants, deleted products, rates, scoped summary, logical timeline, tenant/date isolation, 90-day dashboard.');
} finally { await db.query('ROLLBACK'); await db.end(); }
