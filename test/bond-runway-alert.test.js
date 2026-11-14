import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBondRunwayAlert,
  extractBondRunwayEpochs,
  notifyDiscord,
  updateState,
} from '../bid-bot.js';

const status = {
  voteAccount: 'vote-a',
  epoch: 1076,
  bondRunwayEpochs: 10,
  bondBalanceSol: 25,
  marinadeStakeSol: 100000,
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bid-bot-runway-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const logs = [];
  return {
    root, sent, logs,
    stateFile: join(root, 'bot.state'),
    enabled: true,
    thresholdEpochs: 10,
    dryRun: false,
    notifier: async message => { sent.push(message); return true; },
    logger: message => logs.push(message),
  };
}

const readState = f => JSON.parse(readFileSync(f.stateFile, 'utf8'));

test('runway uses the SDK estimate and clamps negative or underfunded coverage to zero', () => {
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs: 9.75 }), 9.75);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs: -2 }), 0);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 6, bondGoodForNEpochs: 100 }), 0);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 9, bondGoodForNEpochs: 100 }, { minBondBalanceSol: 10 }), 0);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: null }), 0);
});

test('unknown runway never becomes a false zero-epoch alert', () => {
  for (const bondGoodForNEpochs of [undefined, null, NaN, '10']) {
    assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs }), null);
  }
});

test('unlimited runway survives the SDK JSON null representation', () => {
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs: Infinity }), Infinity);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs: null, marinadeActivatedStakeSol: 0 }), Infinity);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 25, bondGoodForNEpochs: null, revShare: { expectedMaxEffBidPmpe: 0 } }), Infinity);
  assert.equal(extractBondRunwayEpochs({ bondBalanceSol: 0, bondGoodForNEpochs: null, marinadeActivatedStakeSol: 0 }), 0);
});

test('runway alert includes exactly 10 epochs and rejects values above the threshold', async t => {
  for (const [runway, expected] of [[10, true], [9.99, true], [0, true], [10.0001, false], [Infinity, false]]) {
    const f = fixture(t);
    assert.equal(await checkBondRunwayAlert({ ...status, bondRunwayEpochs: runway }, f), expected);
    assert.equal(f.sent.length, Number(expected));
    if (expected) {
      assert.match(f.sent[0], /Bond runway가 10에폭 이하/);
      assert.match(f.sent[0], /Bond 잔액: 25\.00 SOL/);
      assert.match(f.sent[0], /활성 stake: 100,000\.00 SOL/);
      assert.equal(readState(f).bond_runway_alert.last_alert_epoch, 1076);
    }
  }
});

test('persistent state suppresses repeated alerts across runs and reminds once per epoch', async t => {
  const f = fixture(t);
  assert.equal(await checkBondRunwayAlert(status, f), true);
  assert.equal(await checkBondRunwayAlert({ ...status, bondRunwayEpochs: 8 }, { ...f }), false);
  assert.equal(await checkBondRunwayAlert({ ...status, epoch: 1077, bondRunwayEpochs: 7 }, f), true);
  assert.equal(await checkBondRunwayAlert({ ...status, epoch: 1077, bondRunwayEpochs: 6 }, f), false);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(readdirSync(f.root), ['bot.state']);
});

test('recovery above 10 epochs rearms a new low-runway alert in the same epoch', async t => {
  const f = fixture(t);
  await checkBondRunwayAlert(status, f);
  assert.equal(await checkBondRunwayAlert({ ...status, bondRunwayEpochs: 11 }, f), false);
  assert.equal(readState(f).bond_runway_alert.active, false);
  assert.equal(await checkBondRunwayAlert({ ...status, bondRunwayEpochs: 9 }, f), true);
  assert.equal(f.sent.length, 2);
});

test('unknown values leave the previous alert state intact', async t => {
  const f = fixture(t);
  await checkBondRunwayAlert(status, f);
  const saved = readState(f);
  for (const runway of [null, undefined, NaN]) {
    assert.equal(await checkBondRunwayAlert({ ...status, bondRunwayEpochs: runway }, f), false);
    assert.deepEqual(readState(f), saved);
  }
  assert.equal(f.sent.length, 1);
});

test('failed Discord delivery retries without recording a successful alert', async t => {
  const f = fixture(t);
  const failed = { ...f, notifier: async () => false };
  assert.equal(await checkBondRunwayAlert(status, failed), false);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(await checkBondRunwayAlert(status, f), true);
  assert.equal(f.sent.length, 1);
});

test('notification exceptions do not abort the bid cycle or consume the alert', async t => {
  const f = fixture(t);
  assert.equal(await checkBondRunwayAlert(status, { ...f, notifier: async () => { throw new Error('network down'); } }), false);
  assert.equal(existsSync(f.stateFile), false);
  assert.match(f.logs.join('\n'), /network down/);
  assert.equal(await checkBondRunwayAlert(status, f), true);
});

test('bid updates and runway alerts preserve each other in the shared state file', async t => {
  const f = fixture(t);
  updateState({ last_bid: 0.0249, last_change_at: 'previous', epoch: 1075 }, f.stateFile);
  await checkBondRunwayAlert(status, f);
  const saved = readState(f).bond_runway_alert;
  assert.equal(readState(f).last_bid, 0.0249);
  updateState({ last_bid: 0.0255, epoch: 1076 }, f.stateFile);
  assert.deepEqual(readState(f).bond_runway_alert, saved);
  assert.equal(await checkBondRunwayAlert(status, f), false);
});

test('dry-run previews a warning without sending or changing alert state', async t => {
  const f = fixture(t);
  const options = { ...f, dryRun: true };
  assert.equal(await checkBondRunwayAlert(status, options), false);
  assert.equal(f.sent.length, 0);
  assert.equal(existsSync(f.stateFile), false);
  assert.match(f.logs.join('\n'), /DRY_RUN/);
  await checkBondRunwayAlert(status, f);
  const saved = readState(f);
  await checkBondRunwayAlert({ ...status, bondRunwayEpochs: 20 }, options);
  assert.deepEqual(readState(f), saved);
});

test('disabled alerts and invalid thresholds neither send nor persist state', async t => {
  const f = fixture(t);
  for (const option of [{ enabled: false }, { thresholdEpochs: NaN }, { thresholdEpochs: -1 }]) {
    assert.equal(await checkBondRunwayAlert(status, { ...f, ...option }), false);
  }
  assert.equal(f.sent.length, 0);
  assert.equal(existsSync(f.stateFile), false);
});

test('a different validator does not inherit the previous validator alert suppression', async t => {
  const f = fixture(t);
  await checkBondRunwayAlert(status, f);
  assert.equal(await checkBondRunwayAlert({ ...status, voteAccount: 'vote-b' }, f), true);
  assert.equal(readState(f).bond_runway_alert.vote_account, 'vote-b');
});

test('Discord sender reports success, missing webhooks, and HTTP failures correctly', async () => {
  let requests = 0;
  const options = {
    webhook: 'https://discord.invalid/test',
    logger: () => {},
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(JSON.parse(init.body).content, 'runway alert');
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(null, { status: 204 });
    },
  };
  assert.equal(await notifyDiscord('runway alert', options), true);
  assert.equal(await notifyDiscord('runway alert', { ...options, webhook: '' }), false);
  assert.equal(requests, 1);
  assert.equal(await notifyDiscord('runway alert', { ...options, fetchImpl: async () => new Response('unavailable', { status: 503 }) }), false);
});
