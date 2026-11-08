// Paid-model phone evaluation: exactly 20 questions through the Android app.
//
// Each question opens a fresh chat, types into the real composer, taps Send, then
// polls the app's own message store for the assistant reply. Nothing is fabricated:
// the recorded content, toolsUsed, usage and model are what the app saved.
//
// Cost guard: QUESTIONS.length === 20. Do not add questions without owner approval.

import 'dotenv/config';
import mongoose from 'mongoose';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import env from '../src/config/env.ts';

const DEVICE = process.env.PAID20_DEVICE || 'PV4DDMIZZLTCIVSK';
const BUSINESS_ID = new mongoose.Types.ObjectId(process.env.PAID20_BUSINESS_ID || '6aee0e2c451a92d902af1190');
const USER_ID = new mongoose.Types.ObjectId(process.env.PAID20_USER_ID || '6aee0e2c451a92d902af1191');
const OUT = new URL(process.env.EVAL_OUT || '../.tmp-paid-20-phone.json', import.meta.url);
const EXPECTED_MODEL = process.env.EVAL_EXPECTED_MODEL || 'openai/gpt-oss-120b';

const QUESTIONS = [
  // Bisaya (Cebuano) — 7
  { id: 'B1', lang: 'Bisaya', text: 'Pila ka aktibong produkto ang naa nato ug pila ka yunit ang tanan sa stock', expected: '1,000 active products; 241,159 units' },
  { id: 'B2', lang: 'Bisaya', text: 'Pila ka produkto ang ubos na sa stock ug pila ang nahurot', expected: '92 low; 57 out of stock' },
  { id: 'B3', lang: 'Bisaya', text: 'Asa nahimutang ang Logitech MX Master 3S 10663 ug pila ka yunit ang naa sa matag lokasyon', expected: 'Logitech MX Master 3S 10663; Main Warehouse 452; Shop Front 453' },
  { id: 'B4', lang: 'Bisaya', text: 'Tagpila ang Dell UltraSharp U2723QE 10232 ug pila ka yunit ang naa', expected: 'Dell UltraSharp U2723QE 10232; 38,990; 0 units / out of stock' },
  { id: 'B5', lang: 'Bisaya', text: 'Pila ka produkto ang naa sa Keyboards and Mice nga kategoriya ug pila ka yunit', expected: 'Keyboards & Mice: 432 products; 104,843 units' },
  { id: 'B6', lang: 'Bisaya', text: 'Naa ba tay mga produkto para sa pag-ayo sa sakyanan', expected: 'No vehicle-repair products' },
  { id: 'B7', lang: 'Bisaya', text: 'Pangitaa ang mga review sa Logitech MX Master 3S 10663 ug ibutang ang mga source', expected: 'Reviews with source URL, or explicit unavailable' },

  // Tagalog — 7
  { id: 'T1', lang: 'Tagalog', text: 'Ilan ang active na produkto natin at ilan ang kabuuang units sa stock', expected: '1,000 active products; 241,159 units' },
  { id: 'T2', lang: 'Tagalog', text: 'Ilan ang mababa na sa stock at ilan ang out of stock', expected: '92 low; 57 out of stock' },
  { id: 'T3', lang: 'Tagalog', text: 'Magkano ang Dell UltraSharp U2723QE 10232 at ilan ang stock nito', expected: 'Dell UltraSharp U2723QE 10232; 38,990; 0 units / out of stock' },
  { id: 'T4', lang: 'Tagalog', text: 'Magkano ang kabuuang halaga ng Keyboards and Mice category', expected: 'Keyboards & Mice value 787,504,593' },
  { id: 'T5', lang: 'Tagalog', text: 'Ihambing ang Logitech MX Master 3S 10663 at Dell UltraSharp U2723QE 10652 sa presyo at stock', expected: 'Logitech MX Master 3S 10663 5,490 / 905; Dell UltraSharp U2723QE 10652 38,990 / 818' },
  { id: 'T6', lang: 'Tagalog', text: 'Anong produkto ang irerekomenda mo para sa maliit na opisina na may budget na 3,000', expected: 'Royal Kludge RK61 10004; 2,499; 218 units / in stock' },
  { id: 'T7', lang: 'Tagalog', text: 'Maghanap ng online na presyo ng Samsung Portable SSD T7 Shield 1TB 10557 at magbigay ng sources', expected: 'Online price with source, or explicit unavailable' },

  // English — 6
  { id: 'E1', lang: 'English', text: 'Which brands do we carry', expected: '12 brands: ASUS ROG, Anker, Dell, Elgato, Keychron, LG, Logitech, Razer, Royal Kludge, Samsung, Sony, SteelSeries' },
  { id: 'E2', lang: 'English', text: 'How many products and units are at Main Warehouse', expected: '1,000 products; 179,016 units' },
  { id: 'E3', lang: 'English', text: 'How many products need restocking and name three of them', expected: '149 products at/below minimum; any three genuine low/out names' },
  { id: 'E4', lang: 'English', text: 'Which item has the highest stock value', expected: 'Dell UltraSharp U2723QE 10652; 31,893,820' },
  { id: 'E5', lang: 'English', text: 'Show me the five most recent stock movements', expected: 'Five latest movements with names and quantities' },
  { id: 'E6', lang: 'English', text: 'Which item had the most units leave Main Warehouse', expected: 'LG UltraGear 27GP850-B 10583; 575 units' },
];

if (QUESTIONS.length !== 20) throw new Error(`Refusing: expected exactly 20 questions, got ${QUESTIONS.length}`);
const START_INDEX = Math.max(0, Math.min(19, Number.parseInt(process.env.PAID20_START_INDEX ?? '0', 10) || 0));
const END_INDEX = Math.max(
  START_INDEX + 1,
  Math.min(QUESTIONS.length, Number.parseInt(process.env.EVAL_END_INDEX ?? String(QUESTIONS.length), 10) || QUESTIONS.length),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normaliseText = (value) => String(value).replace(/\s+/g, ' ').trim().toLowerCase();

function adb(args) {
  return execFileSync('adb', ['-s', DEVICE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function credits() {
  const response = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  });
  if (!response.ok) return { status: response.status };
  const body = await response.json();
  return body.data ?? null;
}

async function latestReply(startedAt) {
  const db = mongoose.connection.db;
  const message = await db
    .collection('ai_messages')
    .findOne(
      { role: 'ASSISTANT', createdAt: { $gte: new Date(startedAt - 1500) } },
      { sort: { createdAt: -1 } },
    );
  if (!message) return null;
  const conversation = await db.collection('ai_conversations').findOne({
    _id: message.conversationId,
    businessId: BUSINESS_ID,
    userId: USER_ID,
  });
  return conversation ? { conversation, message } : null;
}

function uiDump() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/window.xml']);
  return adb(['shell', 'cat', '/sdcard/window.xml']);
}

async function freshChat() {
  // Deep-linking /ai/new while already on /ai/new reuses the mounted screen and its draft.
  // Leave the thread, land on the AI hub, and push a NEW chat so AiChat remounts empty.
  adb(['shell', 'input', 'keyevent', '4']);
  await sleep(700);
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'inventoryai://ai']);
  await sleep(900);
  let xml = uiDump();
  if (!xml.includes('text="New chat"')) {
    adb(['shell', 'input', 'keyevent', '4']);
    await sleep(600);
    adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'inventoryai://ai']);
    await sleep(900);
    xml = uiDump();
  }
  const button = /text="New chat"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  if (!button) throw new Error('AI hub did not expose the New chat button');
  const x = Math.round((Number(button[1]) + Number(button[3])) / 2);
  const y = Math.round((Number(button[2]) + Number(button[4])) / 2);
  adb(['shell', 'input', 'tap', String(x), String(y)]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(600);
    try {
      xml = uiDump();
      if (xml.includes('text="Ask about your stock…"') && !xml.includes('resource-id="chat-time-user"')) return;
    } catch {
      // The hierarchy is briefly unavailable while the activity is still drawing.
    }
  }
  throw new Error('fresh chat did not open with an empty composer');
}

await mongoose.connect(env.mongodbUri, { dbName: env.mongodbDbName });

const startedAt = Date.now();
const creditsBefore = await credits();
const results = [];
let aborted = null;

for (const [offset, question] of QUESTIONS.slice(START_INDEX, END_INDEX).entries()) {
  const index = START_INDEX + offset;
  const questionStarted = Date.now();
  const row = { ...question, index: index + 1, askedAt: new Date(questionStarted).toISOString() };
  try {
    let typedOk = false;
    for (let attempt = 0; attempt < 2 && !typedOk; attempt += 1) {
      await freshChat();
      adb(['shell', 'input', 'tap', '400', '2100']);
      await sleep(700);
      adb(['shell', 'input', 'text', question.text.replace(/ /g, '%s')]);
      for (let check = 0; check < 8; check += 1) {
        await sleep(500);
        const typed = uiDump();
        const field = /text="([^"]*)"[^>]*class="android.widget.EditText"/.exec(typed);
        if (field && normaliseText(field[1]) === normaliseText(question.text)) {
          typedOk = true;
          break;
        }
      }
    }
    if (!typedOk) throw new Error('composer text did not match the question; refusing to send');
    // Keyboard is open, which moves Send to roughly y=1338.
    adb(['shell', 'input', 'tap', '900', '1338']);

    let reply = null;
    const deadline = Date.now() + 95000;
    while (Date.now() < deadline) {
      await sleep(2000);
      reply = await latestReply(questionStarted);
      if (reply) break;
    }

    if (!reply) {
      row.error = 'timeout waiting for stored assistant reply';
    } else {
      row.answer = String(reply.message.content ?? '');
      row.model = reply.message.model ?? null;
      row.toolsUsed = reply.message.toolsUsed ?? [];
      row.usage = reply.message.usage ?? null;
      row.degraded = reply.message.degraded ?? null;
      row.conversationId = String(reply.conversation._id);
      row.latencyMs = Date.now() - questionStarted;
      const storedUser = await mongoose.connection.db
        .collection('ai_messages')
        .findOne(
          { conversationId: reply.conversation._id, role: 'USER', createdAt: { $gte: new Date(questionStarted - 1500) } },
          { sort: { createdAt: 1 } },
        );
      if (storedUser) {
        row.storedPrompt = String(storedUser.content);
        if (normaliseText(row.storedPrompt) !== normaliseText(question.text)) {
          row.promptMismatch = row.storedPrompt;
        }
      }
      if (row.model !== EXPECTED_MODEL) {
        aborted = `${question.id} came from ${row.model}, expected ${EXPECTED_MODEL}`;
      } else if (row.degraded) {
        aborted = `${question.id} was marked degraded=${row.degraded}`;
      } else if (row.promptMismatch) {
        aborted = `${question.id} stored a different prompt than the one sent`;
      }
    }
  } catch (error) {
    row.error = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
  }
  if (!aborted && row.error) aborted = `${question.id} failed: ${row.error}`;
  row.finishedAt = new Date().toISOString();
  results.push(row);
  console.log(`[paid-20] ${row.index}/20 ${question.id} ${question.lang} ${row.error ? `ERROR ${row.error}` : `${row.latencyMs}ms tools=${(row.toolsUsed || []).join(',') || 'none'} model=${row.model}`}`);
  console.log(`[paid-20] Q: ${question.text}`);
  console.log(`[paid-20] A: ${String(row.answer ?? row.error ?? '').slice(0, 600)}`);
  await writeFile(OUT, `${JSON.stringify({ startedAt: new Date(startedAt).toISOString(), startIndex: START_INDEX, endIndex: END_INDEX, creditsBefore, results }, null, 2)}\n`, 'utf8');
  if (aborted) break;
  await sleep(2000);
}

const creditsAfter = await credits();
await writeFile(
  OUT,
  `${JSON.stringify({ startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), startIndex: START_INDEX, endIndex: END_INDEX, creditsBefore, creditsAfter, aborted, results }, null, 2)}\n`,
  'utf8',
);
console.log(`[paid-20] complete ${results.length}/20; credits ${JSON.stringify(creditsBefore)} -> ${JSON.stringify(creditsAfter)}${aborted ? `; ABORTED ${aborted}` : ''}`);
await mongoose.disconnect();
