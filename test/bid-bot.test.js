import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildConfigureBondArgs,
  calculateEpochTiming,
  capSingleDrop,
  chooseLoopDelayMs,
  computeFillRankRowsFromResults,
  computeTargetBid,
  describeMaterialFillRankChanges,
  extractMyStatusFromResults,
  findValidatorNameByVoteAccount,
  formatDiscordCodeBlockMessages,
  formatDiscordContent,
  formatBidCalculationTable,
  formatFillRankChangeReasons,
  formatFillRankImageSvg,
  formatFillRankTable,
  fmtDuration,
  hasFillRankTableChanged,
  hasMaterialFillRankChange,
  isTargetInSanityRange,
  parseCpmpeBid,
  patchDsSamSdkForPrereleaseVersions,
  pmpeToCpmpeLamports,
  readOptionalNumberArg,
  refreshHeavyFiles,
  renderFillRankImagePng,
  resolveMode,
  resolveManualBidFloor,
  shouldChangeBid,
  shouldCheckScheduledFillRankReport,
  shouldRefreshHeavyInputs,
} from '../bid-bot.js';

test('computeTargetBid keeps the highest safety floor and rounds to 4 decimals', () => {
  const target = computeTargetBid(0.04606689167741296, {
    safetyRatio: 1.025,
    winBufferPmpe: 0.0005,
    permittedDev: 0.01,
  });

  assert.equal(target, 0.0472);
});

test('computeTargetBid lets the winning buffer win when it is the highest floor', () => {
  const target = computeTargetBid(0.001, {
    safetyRatio: 1.025,
    winBufferPmpe: 0.0005,
    permittedDev: 0.01,
  });

  assert.equal(target, 0.0015);
});

test('computeTargetBid includes the permitted-deviation floor in the max calculation', () => {
  const target = computeTargetBid(0.10, {
    safetyRatio: 1.0,
    winBufferPmpe: 0,
    permittedDev: -0.10,
  });

  assert.equal(target, 0.11);
});

test('computeTargetBid respects an active manual bid floor', () => {
  const target = computeTargetBid(0.08, {
    safetyRatio: 1.025,
    winBufferPmpe: 0.0005,
    permittedDev: 0.01,
    manualBidFloor: 0.1049,
  });

  assert.equal(target, 0.1049);
});

test('manual bid floor is epoch-scoped and expires after the selected epoch', () => {
  assert.deepEqual(resolveManualBidFloor(980, {
    manualMinBidPmpe: 0.1049,
    manualMinBidUntilEpoch: 980,
  }), {
    floor: 0.1049,
    active: true,
    expired: false,
    untilEpoch: 980,
  });

  assert.deepEqual(resolveManualBidFloor(981, {
    manualMinBidPmpe: 0.1049,
    manualMinBidUntilEpoch: 980,
  }), {
    floor: 0,
    active: false,
    expired: true,
    untilEpoch: 980,
  });
});

test('manual bid floor flags parse inline and separated values', () => {
  assert.equal(readOptionalNumberArg([
    '--loop',
    '--manual-min-bid-pmpe',
    '0.1049',
  ], '--manual-min-bid-pmpe'), 0.1049);

  assert.equal(readOptionalNumberArg([
    '--manual-min-bid-until-epoch=981',
  ], '--manual-min-bid-until-epoch'), 981);

  assert.equal(readOptionalNumberArg(['--manual-min-bid-pmpe', 'abc'], '--manual-min-bid-pmpe'), null);
});

test('PMPE to cpmpe lamports conversion is stable', () => {
  assert.equal(pmpeToCpmpeLamports(0.0475), 47_500_000);
  assert.equal(pmpeToCpmpeLamports(0.0484), 48_400_000);
  assert.equal(pmpeToCpmpeLamports(Number.NaN), null);
});

test('validator-bonds cpmpe parsing rejects missing or non-numeric values', () => {
  assert.equal(parseCpmpeBid('47500000 lamports'), 0.0475);
  assert.equal(parseCpmpeBid('47,500,000'), 0.0475);
  assert.equal(parseCpmpeBid('0 lamports'), 0);
  assert.equal(parseCpmpeBid(''), null);
  assert.equal(parseCpmpeBid(null), null);
});

test('minimum bid-change threshold suppresses tiny changes only', () => {
  assert.equal(shouldChangeBid(0.0475, 0.0472, 0.0005), false);
  assert.equal(shouldChangeBid(0.0475, 0.0470001, 0.0005), false);
  assert.equal(shouldChangeBid(0.0480, 0.0475, 0.0005), true);
});

test('target sanity range accepts only finite values inside inclusive bounds', () => {
  assert.equal(isTargetInSanityRange(0.005, 0.005, 0.20), true);
  assert.equal(isTargetInSanityRange(0.20, 0.005, 0.20), true);
  assert.equal(isTargetInSanityRange(0.0049, 0.005, 0.20), false);
  assert.equal(isTargetInSanityRange(0.2001, 0.005, 0.20), false);
  assert.equal(isTargetInSanityRange(Number.NaN, 0.005, 0.20), false);
});

test('single-drop cap prevents a large one-shot bid decrease', () => {
  assert.deepEqual(capSingleDrop(0.10, 0.06, 0.05, 0.02), {
    target: 0.08,
    capped: true,
    blocked: false,
  });
  assert.deepEqual(capSingleDrop(0.10, 0.06, 0.09, 0.02), {
    target: 0.08,
    capped: true,
    blocked: true,
  });
  assert.deepEqual(capSingleDrop(0.05, 0.06, 0.04, 0.02), {
    target: 0.06,
    capped: false,
    blocked: false,
  });
  assert.deepEqual(capSingleDrop(0.10, 0.08, 0.05, 0.02), {
    target: 0.08,
    capped: false,
    blocked: false,
  });
});

test('extractMyStatusFromResults preserves the fields that drive bid decisions', () => {
  const data = {
    winningTotalPmpe: 0.3479,
    auctionData: {
      epoch: 968,
      validators: [
        {
          voteAccount: 'vote-a',
          revShare: {
            bidPmpe: 0.0475,
            effParticipatingBidPmpe: 0.0461,
            totalPmpe: 0.3494,
            bondObligationPmpe: 0.302,
            bidTooLowPenaltyPmpe: 0,
          },
          auctionStake: {
            marinadeSamTargetSol: 96820.57032704525,
          },
          marinadeActivatedStakeSol: 12345,
          bondBalanceSol: 678,
          samEligible: true,
          lastCapConstraint: {
            constraintType: 'none',
          },
        },
      ],
    },
  };

  const status = extractMyStatusFromResults(data, 'vote-a');
  const { cutoffMargin, ...stableFields } = status;

  assert.ok(Math.abs(cutoffMargin - 0.0015) < 1e-12);
  assert.deepEqual(stableFields, {
    epoch: 968,
    voteAccount: 'vote-a',
    bidPmpe: 0.0475,
    effPart: 0.0461,
    totalPmpe: 0.3494,
    bondObligation: 0.302,
    bidTooLowPenalty: 0,
    winningTotalPmpe: 0.3479,
    samTargetSol: 96820.57032704525,
    marinadeStakeSol: 12345,
    bondBalanceSol: 678,
    samEligible: true,
    lastCapConstraint: 'none',
  });
  assert.equal(extractMyStatusFromResults(data, 'missing-vote'), null);
});

test('epoch timing uses remaining slots and recent slot throughput', () => {
  const timing = calculateEpochTiming(
    { epoch: 968, slotIndex: 431000, slotsInEpoch: 432000 },
    [
      { numSlots: 150, samplePeriodSecs: 60 },
      { numSlots: 150, samplePeriodSecs: 60 },
    ],
  );

  assert.equal(timing.epoch, 968);
  assert.equal(timing.slotsRemaining, 1000);
  assert.equal(timing.slotsPerSecond, 2.5);
  assert.equal(timing.remainingSeconds, 400);
});

test('epoch timing rejects unusable performance samples', () => {
  assert.throws(
    () => calculateEpochTiming(
      { epoch: 968, slotIndex: 100, slotsInEpoch: 432000 },
      [{ numSlots: 0, samplePeriodSecs: 0 }],
    ),
    /최근 slot 처리 속도/,
  );
});

test('epoch-aware loop switches from base interval to fast interval near epoch end', () => {
  const opts = {
    enabled: true,
    loopIntervalMs: 3_600_000,
    thresholdSeconds: 3_600,
    fastLoopIntervalMs: 300_000,
  };

  assert.deepEqual(chooseLoopDelayMs({ remainingSeconds: 30 * 3600 }, opts), {
    delayMs: 3_600_000,
    fastMode: false,
  });
  assert.deepEqual(chooseLoopDelayMs({ remainingSeconds: 45 * 60 }, opts), {
    delayMs: 300_000,
    fastMode: true,
  });
  assert.deepEqual(chooseLoopDelayMs({ remainingSeconds: 45 * 60 }, { ...opts, enabled: false }), {
    delayMs: 3_600_000,
    fastMode: false,
  });
});

test('human-readable duration keeps hour and minute boundaries stable', () => {
  assert.equal(fmtDuration(30 * 3600 + 5 * 60), '30시간 5분');
  assert.equal(fmtDuration(300), '5분');
  assert.equal(fmtDuration(42), '42초');
});

test('loop mode wins when fill-rank is requested with loop', () => {
  assert.equal(resolveMode(['--loop', '--fill-rank', '--rank-limit', '9']), 'loop');
  assert.equal(resolveMode(['--fill-rank', '--rank-limit', '9', '--loop']), 'loop');
  assert.equal(resolveMode(['--fill-rank', '--rank-limit', '9']), 'fill-rank');
});

test('bid change table shows dynamic values without fixed config thresholds by default', () => {
  const status = {
    epoch: 968,
    samEligible: true,
    winningTotalPmpe: 0.34794449828177,
    totalPmpe: 0.349377606604357,
    cutoffMargin: 0.001433108322587029,
    effPart: 0.04606689167741296,
    bidTooLowPenalty: 0,
    samTargetSol: 96820.57032704525,
  };

  const table = formatBidCalculationTable(status, 0.0475, 0.0484, {
    title: 'bid 변경 계산',
  });

  assert.match(table, /bid 변경 계산/);
  assert.match(table, /Item\s+Value/);
  assert.match(table, /Current Bid\s+0\.0475 PMPE/);
  assert.match(table, /Target Bid\s+0\.0484 PMPE/);
  assert.match(table, /Bid Change\s+0\.0475 PMPE -> 0\.0484 PMPE/);
  assert.match(table, /Current CPMPE\s+47500000/);
  assert.match(table, /Target CPMPE\s+48400000/);
  assert.doesNotMatch(table, /Min Change/);
});

test('bid change table shows an active manual floor when configured', () => {
  const status = {
    epoch: 980,
    samEligible: true,
    winningTotalPmpe: 0.34794449828177,
    totalPmpe: 0.349377606604357,
    cutoffMargin: 0.001433108322587029,
    effPart: 0.0800,
    bidTooLowPenalty: 0,
    samTargetSol: 96820.57032704525,
  };

  const table = formatBidCalculationTable(status, 0.1049, 0.1049, {
    manualBidFloor: 0.1049,
    manualBidFloorUntilEpoch: 980,
  });

  assert.match(table, /Manual Floor\s+0\.1049 PMPE \(until epoch 980\)/);
  assert.match(table, /Target Bid\s+0\.1049 PMPE/);
});

test('dry-run bid table can include the fixed min-change threshold explicitly', () => {
  const status = {
    epoch: 968,
    samEligible: true,
    winningTotalPmpe: 0.34794449828177,
    totalPmpe: 0.349377606604357,
    cutoffMargin: 0.001433108322587029,
    effPart: 0.04606689167741296,
    bidTooLowPenalty: 0,
    samTargetSol: 96820.57032704525,
  };

  const table = formatBidCalculationTable(status, 0.0475, 0.0472, {
    includeMinChange: true,
  });

  assert.match(table, /Min Change\s+0\.0005 PMPE/);
});

test('fill-rank table uses redelegation budget and keeps SOL columns whole-numbered', async () => {
  const data = {
    auctionData: {
      epoch: 979,
      stakeAmounts: {
        marinadeSamTvlSol: 1000,
      },
      rewards: {
        inflationPmpe: 0.30,
        mevPmpe: 0.02,
      },
      validators: [
        {
          voteAccount: 'rank-two',
          stakePriority: 20,
          marinadeActivatedStakeSol: 100,
          auctionStake: { marinadeSamTargetSol: 700 },
          revShare: { bidPmpe: 0.15, totalPmpe: 0.435 },
          lastCapConstraint: { constraintType: 'WANT' },
        },
        {
          voteAccount: 'rank-one',
          stakePriority: 10,
          marinadeActivatedStakeSol: 300,
          auctionStake: { marinadeSamTargetSol: 450.4 },
          revShare: { bidPmpe: 0.301, totalPmpe: 0.621 },
          lastCapConstraint: { constraintType: 'BOND' },
        },
        {
          voteAccount: 'not-receiving',
          stakePriority: 1,
          marinadeActivatedStakeSol: 250,
          auctionStake: { marinadeSamTargetSol: 250 },
          revShare: { bidPmpe: 0.5 },
          lastCapConstraint: null,
        },
      ],
    },
  };

  const result = computeFillRankRowsFromResults(data, { limit: 9 });

  assert.equal(result.redelegateBudget, 350);
  assert.equal(result.receiverCount, 2);
  assert.equal(result.rows[0].normalizedBidPmpe, 0.316);
  assert.equal(result.rows[1].normalizedBidPmpe, 0.13);
  assert.deepEqual(result.rows.map(row => ({
    rank: row.rank,
    voteAccount: row.voteAccount,
    need: row.need,
    fill: row.fill,
    fillPct: row.fillPct,
  })), [
    { rank: 1, voteAccount: 'rank-one', need: 150.39999999999998, fill: 150.39999999999998, fillPct: 1 },
    { rank: 2, voteAccount: 'rank-two', need: 600, fill: 199.60000000000002, fillPct: 0.3326666666666667 },
  ]);

  const table = formatFillRankTable(result);
  assert.match(table, /Re-delegate budget: 350 SOL/);
  assert.match(table, /Rank\s+Vote\s+Stake\s+Target\s+Active\s+받을 Stake\s+Fill 예상\s+Fill\s+Bid\s+Bid @5\/0/);
  assert.match(table, /Priority/);
  assert.match(table, /\b1\s+rank-one\s+10\s+450\s+300\s+150\s+150\s+100%\s+0\.3010\s+0\.3160/);
  assert.match(table, /\b2\s+rank-two\s+20\s+700\s+100\s+600\s+200\s+33%\s+0\.1500\s+0\.1300/);
  assert.doesNotMatch(table, /Constraint/);
  assert.doesNotMatch(table, /BOND/);
  assert.doesNotMatch(table, /WANT/);
  assert.doesNotMatch(table, /\|/);

  const svg = formatFillRankImageSvg(result, {
    title: 'fill-rank --rank-limit 9',
    reason: 'changed',
  });
  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /);
  assert.match(svg, /Fill/);
  assert.match(svg, /Expected/);
  assert.match(svg, /rank-one/);
  assert.match(svg, /fill="#0b0b0f"/);
  assert.match(svg, /fill: #f8fafc/);
  assert.match(svg, /fill="#047857"/);
  assert.doesNotMatch(svg, /받을 Stake/);

  const png = await renderFillRankImagePng(result, {
    title: 'fill-rank --rank-limit 9',
    reason: 'changed',
  });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('scheduled fill-rank report checks immediately and then every hour', () => {
  const oneHour = 60 * 60 * 1000;

  assert.equal(shouldCheckScheduledFillRankReport(1_000, null, oneHour), true);
  assert.equal(shouldCheckScheduledFillRankReport(1_000 + oneHour - 1, 1_000, oneHour), false);
  assert.equal(shouldCheckScheduledFillRankReport(1_000 + oneHour, 1_000, oneHour), true);
});

test('fill-rank Discord report sends only when the table changes', () => {
  const table = 'Rank  Vote\n   1  A11pGb...KtS5';

  assert.equal(hasFillRankTableChanged(table, null), true);
  assert.equal(hasFillRankTableChanged(table, table), false);
  assert.equal(hasFillRankTableChanged(`${table}\n   2  HHLMTH...ubgq`, table), true);
});

function sampleFillRankResult() {
  return {
    epoch: 982,
    redelegateBudget: 128_000,
    receiverCount: 2,
    rows: [
      {
        rank: 1,
        voteAccount: 'rank-one',
        stakePriority: 10,
        target: 120_000,
        active: 110_000,
        need: 10_000,
        fill: 10_000,
        fillPct: 1,
        bidPmpe: 0.1510,
        normalizedBidPmpe: 0.1664,
      },
      {
        rank: 2,
        voteAccount: 'rank-two',
        stakePriority: 20,
        target: 90_000,
        active: 80_000,
        need: 10_000,
        fill: 5_000,
        fillPct: 0.5,
        bidPmpe: 0.1151,
        normalizedBidPmpe: 0.1151,
      },
    ],
  };
}

test('material fill-rank change ignores small numeric drift', () => {
  const last = sampleFillRankResult();
  const current = JSON.parse(JSON.stringify(last));
  current.redelegateBudget += 999;
  current.rows[0].target += 999;
  current.rows[0].fillPct -= 0.009;
  current.rows[1].bidPmpe += 0.0004;

  assert.equal(hasMaterialFillRankChange(current, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  }), false);
  assert.deepEqual(describeMaterialFillRankChanges(current, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  }), []);
});

test('material fill-rank change detects rank and threshold changes', () => {
  const last = sampleFillRankResult();
  assert.equal(hasMaterialFillRankChange(last, null), true);
  assert.deepEqual(describeMaterialFillRankChanges(last, null), ['시작 알림: 이전 fill-rank 기준 없음']);

  const stakeChanged = JSON.parse(JSON.stringify(last));
  stakeChanged.redelegateBudget += 1000;
  assert.equal(hasMaterialFillRankChange(stakeChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  }), true);
  assert.deepEqual(describeMaterialFillRankChanges(stakeChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  }), ['minStakeDeltaSol 이상: Re-delegate budget +1,000 SOL (기준 1,000 SOL)']);

  const rankChanged = JSON.parse(JSON.stringify(last));
  rankChanged.rows.reverse();
  assert.equal(hasMaterialFillRankChange(rankChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  }), true);
  assert.match(describeMaterialFillRankChanges(rankChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  })[0], /고정 알림 조건: 순위\/order 변경 #1 rank-one -> rank-two/);
});

test('fill-rank change reasons name the exceeded delta threshold', () => {
  const last = sampleFillRankResult();

  const bidChanged = JSON.parse(JSON.stringify(last));
  bidChanged.rows[1].bidPmpe += 0.0005;
  const bidReasons = describeMaterialFillRankChanges(bidChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  });
  assert.deepEqual(bidReasons, ['minBidDeltaPmpe 이상: Rank 2 rank-two Bid +0.0005 PMPE (기준 0.0005 PMPE)']);

  const fillPctChanged = JSON.parse(JSON.stringify(last));
  fillPctChanged.rows[1].fillPct += 0.01;
  const fillPctReasons = describeMaterialFillRankChanges(fillPctChanged, last, {
    minStakeDeltaSol: 1000,
    minBidDeltaPmpe: 0.0005,
    minFillPctDelta: 0.01,
  });
  assert.deepEqual(fillPctReasons, ['minFillPctDelta 이상: Rank 2 rank-two Fill +1%p (기준 1%p)']);

  const summarized = formatFillRankChangeReasons([
    ...bidReasons,
    ...fillPctReasons,
    'minStakeDeltaSol 이상: Rank 2 rank-two Fill 예상 +1,000 SOL (기준 1,000 SOL)',
  ], { maxReasons: 2 });
  assert.equal(summarized, 'minBidDeltaPmpe 이상: Rank 2 rank-two Bid +0.0005 PMPE (기준 0.0005 PMPE); minFillPctDelta 이상: Rank 2 rank-two Fill +1%p (기준 1%p); 외 1건');
});

test('Discord fill-rank messages wrap fixed-width tables in code blocks', () => {
  const table = [
    'Rank  Vote           Stake  Target',
    '                       Priority',
    '----  -------------  --------  ------',
    '   1  A11pGb...KtS5        14  19,335',
  ].join('\n');

  const [message] = formatDiscordCodeBlockMessages('📊 `bid-bot`: fill-rank --rank-limit 9', table);

  assert.match(message, /^📊 `bid-bot`: fill-rank --rank-limit 9\n```text\n/);
  assert.match(message, /Rank  Vote           Stake  Target/);
  assert.match(message, /Priority/);
  assert.match(message, /   1  A11pGb\.\.\.KtS5        14  19,335/);
  assert.match(message, /\n```$/);
});

test('heavy inputs refresh when live bonds epoch differs from last ds-sam result epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'bid-bot-cache-'));
  const cacheDir = join(root, 'cache');
  const outputDir = join(root, 'output');
  mkdirSync(cacheDir);
  mkdirSync(outputDir);
  writeFileSync(join(cacheDir, 'bonds.json'), JSON.stringify({ bonds: [{ epoch: 982 }] }));
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify({ auctionData: { epoch: 981 } }));

  const status = shouldRefreshHeavyInputs({
    cacheDir,
    outputDir,
    files: [],
    ttl: 24 * 60 * 60,
  });

  assert.equal(status.refresh, true);
  assert.equal(status.epochChanged, true);
  assert.equal(status.bondsEpoch, 982);
  assert.equal(status.resultsEpoch, 981);
  assert.deepEqual(status.reasons, ['epoch 981 -> 982']);
});

test('heavy inputs stay cached when live bonds epoch matches last ds-sam result epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'bid-bot-cache-'));
  const cacheDir = join(root, 'cache');
  const outputDir = join(root, 'output');
  mkdirSync(cacheDir);
  mkdirSync(outputDir);
  writeFileSync(join(cacheDir, 'bonds.json'), JSON.stringify({ bonds: [{ epoch: 982 }] }));
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify({ auctionData: { epoch: 982 } }));

  const status = shouldRefreshHeavyInputs({
    cacheDir,
    outputDir,
    files: [],
    ttl: 24 * 60 * 60,
  });

  assert.equal(status.refresh, false);
  assert.equal(status.epochChanged, false);
  assert.equal(status.bondsEpoch, 982);
  assert.equal(status.resultsEpoch, 982);
});

test('refreshHeavyFiles reports failed heavy inputs before calculation can continue', async () => {
  const files = [
    ['validators.json', 'https://example.invalid/validators'],
    ['rewards.json', 'https://example.invalid/rewards'],
    ['auctions.json', 'https://example.invalid/auctions'],
  ];
  const calls = [];

  const failedFiles = await refreshHeavyFiles(files, '/tmp/bid-bot-cache', async (url, dest) => {
    calls.push({ url, dest });
    return !dest.endsWith('/rewards.json');
  });

  assert.deepEqual(failedFiles, ['rewards.json']);
  assert.deepEqual(calls, [
    { url: 'https://example.invalid/validators', dest: '/tmp/bid-bot-cache/validators.json' },
    { url: 'https://example.invalid/rewards', dest: '/tmp/bid-bot-cache/rewards.json' },
    { url: 'https://example.invalid/auctions', dest: '/tmp/bid-bot-cache/auctions.json' },
  ]);
});

test('findValidatorNameByVoteAccount reads Marinade validator names by vote account', () => {
  const data = {
    validators: [
      {
        vote_account: 'vote-a',
        info_name: '  Staking   Fund  ',
      },
      {
        vote_account: 'vote-b',
        info_name: 'Other Validator',
      },
    ],
  };

  assert.equal(findValidatorNameByVoteAccount(data, 'vote-a'), 'Staking Fund');
  assert.equal(findValidatorNameByVoteAccount(data, 'missing-vote'), null);
});

test('formatDiscordContent prefixes alerts with the resolved validator name', () => {
  assert.equal(
    formatDiscordContent('✅ `bid-bot`: on-chain bid 변경 완료', 'Staking Fund'),
    '[Staking Fund] ✅ `bid-bot`: on-chain bid 변경 완료',
  );
  assert.equal(formatDiscordContent('plain message', ''), 'plain message');
});

test('configure-bond args add force only for explicit bid decreases', () => {
  assert.deepEqual(
    buildConfigureBondArgs('bond-a', 47_200_000, {
      authorityFile: './auth.json',
      keypairFile: './keypair.json',
      force: true,
    }),
    [
      'configure-bond', 'bond-a',
      '--authority', './auth.json',
      '--cpmpe', '47200000',
      '-k', './keypair.json',
      '--force',
    ],
  );
  assert.deepEqual(
    buildConfigureBondArgs('bond-a', 48_500_000, {
      authorityFile: './auth.json',
      keypairFile: './keypair.json',
      force: false,
    }),
    [
      'configure-bond', 'bond-a',
      '--authority', './auth.json',
      '--cpmpe', '48500000',
      '-k', './keypair.json',
    ],
  );
});

test('ds-sam patch allows prerelease client versions in semver checks', () => {
  const before = 'if (!semver.satisfies(validator.clientVersion, this.config.validatorsClientVersionSemverExpr)) return false';
  const result = patchDsSamSdkForPrereleaseVersions(before);

  assert.equal(result.patched, true);
  assert.equal(result.alreadyPatched, false);
  assert.match(result.source, /includePrerelease: true/);

  const second = patchDsSamSdkForPrereleaseVersions(result.source);
  assert.equal(second.patched, false);
  assert.equal(second.alreadyPatched, true);
  assert.equal(second.source, result.source);
});
