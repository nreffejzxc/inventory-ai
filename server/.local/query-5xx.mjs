// READ-ONLY inspection of the durable 5xx store (ops_error_events) on production.
// Prints only aggregate shapes: day, status, code, method, normalized route.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set');
  process.exit(2);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db('inventoryai_prod_db');
  const col = db.collection('ops_error_events');

  const total = await col.countDocuments();
  const oldest = await col.find({}).sort({ occurredAt: 1 }).limit(1).toArray();
  const newest = await col.find({}).sort({ occurredAt: -1 }).limit(1).toArray();
  console.log('collection: ops_error_events');
  console.log('total rows:', total);
  console.log('oldest:', oldest[0]?.occurredAt?.toISOString?.() ?? null);
  console.log('newest:', newest[0]?.occurredAt?.toISOString?.() ?? null);

  const byDay = await col
    .aggregate([
      { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }, s: '$status' }, n: { $sum: 1 } } },
      { $sort: { '_id.d': -1 } },
    ])
    .toArray();
  console.log('\nby day/status:');
  for (const row of byDay.slice(0, 40)) console.log(`  ${row._id.d}  ${row._id.s}  ${row.n}`);

  const byRoute = await col
    .aggregate([
      { $group: { _id: { r: '$route', m: '$method', s: '$status', c: '$code' }, n: { $sum: 1 }, last: { $max: '$occurredAt' } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  console.log('\nby route/method/status/code (top 25):');
  for (const row of byRoute.slice(0, 25)) {
    console.log(`  ${String(row.n).padStart(4)}  ${row._id.m ?? '?'} ${row._id.r}  status=${row._id.s} code=${row._id.c ?? '-'}  last=${row.last?.toISOString?.() ?? '-'}`);
  }

  const last24 = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = await col.countDocuments({ occurredAt: { $gte: last24 } });
  const lastHour = await col.countDocuments({ occurredAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
  console.log('\nrows in last 24h:', recent, '| last 1h:', lastHour);

  const samples = await col.find({}).sort({ occurredAt: -1 }).limit(10).toArray();
  console.log('\n10 newest (no tenant ids):');
  for (const row of samples) {
    console.log(`  ${row.occurredAt?.toISOString?.()}  ${row.method} ${row.route}  ${row.status} ${row.code ?? ''}`);
  }
} finally {
  await client.close();
}
