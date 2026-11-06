/**
 * The data guides' commands — every `npm run …` a guide prints must exist as a script.
 *
 * WHY THIS EXISTS. On 2026-10-27 the two data guides were split into four, one per half per
 * environment (Guides 9–12), and the Firebase guide became Guide 13. Moving that much text by hand is
 * exactly how a guide ends up naming a command that was renamed or removed: the prose reads
 * perfectly, the command refuses with `missing script`, and the person following it is standing at
 * their terminal with no idea which side is wrong. The repository already pins the command *surface*
 * (`cleanup-target-guard.test.mjs` proves five removed scripts stay removed); nothing checked that the
 * guides and `package.json` still describe the same commands.
 *
 * WHAT IT MEASURES. For each data/identity guide, every `npm run <name>` occurrence is compared with
 * the `scripts` block of `server/package.json`. All five guides are run
 * from `server/`, so the server's manifest is the only one that can answer for them; the mobile guides
 * are deliberately out of scope,
 * because `npm run check:ota` and friends belong to `mobile/package.json` and a check against the
 * server's scripts would fail on a correct guide.
 *
 * WHAT IT IS NOT, so its green is not read as more than it is:
 *
 *  * **It does not know whether a command is used correctly** — only that the name exists. A guide may
 *    print `npm run seed:accounts` without its `--accounts=`, and this stays green.
 *  * **It reads only `npm run …`.** A bare `seed:accounts` in prose, a removed name mentioned as
 *    removed (Guide 11 names the five dead scripts exactly that way), and every `npx`/`eas` command are
 *    out of scope on purpose.
 *  * **It cannot see that a guide's *description* of a command is stale** — only that its name is real.
 *
 * The extractor and the comparison are controlled in both directions below: a regex that silently
 * matched nothing would otherwise pass forever, which is the failure this kind of guard dies of.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The guides that run their commands from `server/` — the four data guides and the identity guide.
 */
const SERVER_GUIDES = [
  '9-seeding-development.md',
  '10-seeding-production.md',
  '11-deleting-development.md',
  '12-deleting-production.md',
  '13-firebase-identities.md',
];

/** The commands Guide 11 names as removed, so a guide cannot quietly re-adopt one. */
const REMOVED_SCRIPTS = [
  'cleanup:test-mongodb',
  'cleanup:dev-mongodb',
  'cleanup:prod-mongodb',
  'cleanup:all-mongodb',
  'cleanup:firebase-accounts',
];

const guideText = (file) =>
  readFileSync(new URL(`../../docs/guides/${file}`, import.meta.url), 'utf8');

const scripts = Object.keys(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts ?? {},
);

/** Every `npm run <name>` in a text, de-duplicated, in the order they appear. */
function namedCommands(text) {
  return [
    ...new Set(
      [...String(text).matchAll(/npm run ([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g)].map((match) => match[1]),
    ),
  ];
}

/** The names in `text` that are not known scripts. Pure, so the negative control can call it. */
function unknownCommands(text, known = scripts) {
  const set = new Set(known);
  return namedCommands(text).filter((name) => !set.has(name));
}

describe('the data guides name commands that exist', () => {
  test('every guide this guard reads is present and substantial', () => {
    for (const file of SERVER_GUIDES) {
      assert.ok(guideText(file).length > 500, `${file} is missing or has been emptied`);
    }
  });

  test('the extractor finds the commands it is supposed to find', () => {
    // Guards against the silent-pass failure: a broken pattern would find nothing and agree with
    // everything. These names are in the guides today, so their absence is a defect in this file.
    const deleting = namedCommands(guideText('11-deleting-development.md'));
    assert.ok(deleting.includes('cleanup:three'), 'the extractor missed cleanup:three');
    assert.ok(deleting.includes('cleanup:account'), 'the extractor missed cleanup:account');

    const seeding = namedCommands(guideText('9-seeding-development.md'));
    assert.ok(seeding.includes('seed:three'), 'the extractor missed seed:three');
    assert.ok(seeding.includes('check:accounts'), 'the extractor missed check:accounts');
  });

  test('the checker can fail — a name that is not a script is reported', () => {
    assert.deepEqual(unknownCommands('run `npm run made-up:command -- --now`'), ['made-up:command']);
    assert.deepEqual(unknownCommands('npm run seed:three'), []);
  });

  test('no guide names one of the five removed scripts as a command', () => {
    for (const removed of REMOVED_SCRIPTS) {
      assert.ok(!scripts.includes(removed), `${removed} is back in package.json`);
      for (const file of SERVER_GUIDES) {
        assert.ok(
          !namedCommands(guideText(file)).includes(removed),
          `${file} tells the reader to run ${removed}, which does not exist`,
        );
      }
    }
  });

  for (const file of SERVER_GUIDES) {
    test(`${file}: every npm run command is a real script`, () => {
      assert.deepEqual(
        unknownCommands(guideText(file)),
        [],
        `${file} names a command that is not in server/package.json`,
      );
    });
  }
});
