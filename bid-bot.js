#!/usr/bin/env node
// bid-bot.js — Marinade SAM 자동 bid 관리 (Node.js single-file)
//
// 모드:
//   node bid-bot.js              # 1회 실행 (pm2 cron용)
//   node bid-bot.js --setup      # ds-sam clone + install (자동)
//   node bid-bot.js --status     # 현재 상태만 JSON 출력
//   node bid-bot.js --dry-run    # 변경 시뮬레이션만
//   node bid-bot.js --loop       # 무한 루프
//   node bid-bot.js --force-refresh  # heavy 캐시 강제 갱신

import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  statSync, mkdirSync, renameSync, copyFileSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 설정 로드 (우선순위: env > bid-bot.json > default)
// ============================================================
const CONFIG_PATH = process.env.BID_BOT_CONFIG || resolve(__dirname, 'bid-bot.json');
const userCfg = existsSync(CONFIG_PATH)
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  : {};

function get(envVar, jsonPath, defaultVal) {
  if (process.env[envVar] !== undefined) return process.env[envVar];
  let v = userCfg;
  for (const p of jsonPath.split('.')) {
    if (v == null || typeof v !== 'object') { v = undefined; break; }
    v = v[p];
  }
  return v ?? defaultVal;
}
const rel = (p) => p ? resolve(__dirname, p) : '';

const VOTE_ADDR     = get('VOTE_ADDR',     'validator.voteAccount', '');
const AUTH_FILE     = rel(get('AUTH_FILE',     'validator.authFile',    ''));
const KEYPAIR_FILE  = rel(get('KEYPAIR_FILE',  'validator.keypairFile', ''));

const DSSAM_DIR     = rel(get('DSSAM_DIR',     'dssam.dir',          './ds-sam'));
const PIPELINE_DIR  = rel(get('PIPELINE_DIR',  'dssam.pipelineDir',  './ds-sam-pipeline'));
const CACHE_DIR     = rel(get('CACHE_DIR',     'dssam.cacheDir',     './ds-sam-cache'));
const OUTPUT_DIR    = rel(get('OUTPUT_DIR',    'dssam.outputDir',    './ds-sam-output'));
const HEAVY_CACHE_TTL = +get('HEAVY_CACHE_TTL', 'dssam.heavyCacheTtl', 86400);

const SAFETY_RATIO        = +get('SAFETY_RATIO',        'bidStrategy.safetyRatio',       1.05);
const WIN_BUFFER_PMPE     = +get('WIN_BUFFER_PMPE',     'bidStrategy.winBufferPmpe',     0.0005);
const PERMITTED_DEV       = +get('PERMITTED_DEV',       'bidStrategy.permittedDev',      0.01);
const MIN_BID_CHANGE_PMPE = +get('MIN_BID_CHANGE_PMPE', 'bidStrategy.minBidChangePmpe',  0.0005);
const MIN_SANITY_BID      = +get('MIN_SANITY_BID',      'bidStrategy.minSanityBid',      0.005);
const MAX_SANITY_BID      = +get('MAX_SANITY_BID',      'bidStrategy.maxSanityBid',      0.20);
const MAX_SINGLE_DROP     = +get('MAX_SINGLE_DROP',     'bidStrategy.maxSingleDrop',     0.02);
const MAX_STAKE_SOL       = +get('MAX_STAKE_SOL',       'bidStrategy.maxStakeSol',       80000);

const LOG_FILE        = rel(get('LOG_FILE',   'logging.logFile',   './bid-bot.log'));
const STATE_FILE      = rel(get('STATE_FILE', 'logging.stateFile', './bid-bot.state'));
const DISCORD_WEBHOOK = get('DISCORD_WEBHOOK', 'logging.discordWebhook', '');

const DRY_RUN       = String(get('DRY_RUN',       'runtime.dryRun', false)).toLowerCase() === 'true';
const LOOP_INTERVAL = +get('LOOP_INTERVAL', 'runtime.loopInterval', 300) * 1000;

const args = process.argv.slice(2);
const MODE = args.includes('--setup')  ? 'setup'
           : args.includes('--status') ? 'status'
           : args.includes('--loop')   ? 'loop'
           : 'run';
const FORCE_REFRESH = args.includes('--force-refresh');
const FORCE_DRY     = args.includes('--dry-run');
const dryRunActive  = DRY_RUN || FORCE_DRY;

// ============================================================
// 유틸
// ============================================================
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function die(msg) { log(`❌ ERROR: ${msg}`); process.exit(1); }

async function notifyDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (e) { log(`Discord 실패: ${e.message}`); }
}

function which(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: '/bin/bash' });
  return r.status === 0;
}
function freshWithin(file, seconds) {
  if (!existsSync(file)) return false;
  return (Date.now() - statSync(file).mtimeMs) / 1000 <= seconds;
}
async function downloadFile(url, dest, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(dest + '.tmp', buf);
    renameSync(dest + '.tmp', dest);
    return true;
  } catch (e) {
    log(`fetch 실패 ${url}: ${e.message}`);
    return false;
  } finally { clearTimeout(timer); }
}

// ============================================================
// pnpm 자동 설치
// ============================================================
function ensurePnpm() {
  if (which('pnpm')) return;
  log('⚠️ pnpm 미설치 — 자동 설치 시도');

  // 1. corepack (Node 16.10+ 내장, 권장)
  if (which('corepack')) {
    log('corepack로 시도...');
    spawnSync('corepack', ['enable'], { stdio: 'inherit' });
    spawnSync('corepack', ['prepare', 'pnpm@latest', '--activate'], { stdio: 'inherit' });
    if (which('pnpm')) { log('✓ pnpm 설치 (corepack)'); return; }
  }

  // 2. npm install -g
  if (which('npm')) {
    log('npm install -g pnpm 시도...');
    const r = spawnSync('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
    if (r.status === 0 && which('pnpm')) { log('✓ pnpm 설치 (npm)'); return; }
  }

  // 3. standalone
  if (which('curl')) {
    log('standalone installer 시도...');
    const r = spawnSync('sh', ['-c', 'curl -fsSL https://get.pnpm.io/install.sh | sh -'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.env.PATH = `${process.env.HOME}/.local/share/pnpm:${process.env.PATH}`;
      if (which('pnpm')) { log('✓ pnpm 설치 (standalone)'); return; }
    }
  }

  console.error(`
❌ pnpm 자동 설치 실패. 수동 설치 후 재시도:
  corepack enable && corepack prepare pnpm@latest --activate
  또는: npm install -g pnpm
  또는: curl -fsSL https://get.pnpm.io/install.sh | sh -
`);
  process.exit(1);
}

// ============================================================
// ds-sam 자동 설치
// ============================================================
function ensureDsSamReady() {
  const need = !existsSync(DSSAM_DIR)
            || !existsSync(`${DSSAM_DIR}/node_modules`)
            || !existsSync(PIPELINE_DIR)
            || !existsSync(`${PIPELINE_DIR}/auction-config.json`);
  if (!need) return;

  log('⚠️ ds-sam 환경 미준비 — 자동 setup');
  notifyDiscord('🔧 `bid-bot`: ds-sam 자동 설치 시작 (5~10분)');

  for (const cmd of ['git', 'node', 'curl']) {
    if (!which(cmd)) die(`${cmd} 필요. 시스템에 설치하세요`);
  }
  ensurePnpm();

  if (!existsSync(DSSAM_DIR)) {
    log(`Cloning ds-sam → ${DSSAM_DIR}`);
    if (spawnSync('git', ['clone', 'https://github.com/marinade-finance/ds-sam.git', DSSAM_DIR],
                  { stdio: 'inherit' }).status !== 0) die('clone 실패');
  }
  if (!existsSync(PIPELINE_DIR)) {
    log(`Cloning ds-sam-pipeline → ${PIPELINE_DIR}`);
    if (spawnSync('git', ['clone', 'https://github.com/marinade-finance/ds-sam-pipeline.git', PIPELINE_DIR],
                  { stdio: 'inherit' }).status !== 0) die('clone 실패');
  }

  if (!existsSync(`${DSSAM_DIR}/node_modules`)) {
    log('Installing ds-sam (5~10분)...');
    const pnpmEnv = { ...process.env, npm_config_engine_strict: 'false' };
    if (spawnSync('pnpm', ['install', '--frozen-lockfile', '--config.engine-strict=false'],
                  { cwd: DSSAM_DIR, stdio: 'inherit', env: pnpmEnv }).status !== 0)
      die('pnpm install 실패');
    if (spawnSync('pnpm', ['-r', 'build'], { cwd: DSSAM_DIR, stdio: 'inherit', env: pnpmEnv }).status !== 0)
      die('build 실패');
  }

  for (const d of [CACHE_DIR, OUTPUT_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  notifyDiscord('✅ `bid-bot`: ds-sam 설치 완료');
}

// ============================================================
// 데이터 fetch
// ============================================================
const HEAVY_FILES = [
  ['validators.json', 'https://validators-api.marinade.finance/validators?epochs=11&limit=1000000'],
  ['mev-info.json',   'https://validators-api.marinade.finance/mev'],
  ['rewards.json',    'https://validators-api.marinade.finance/rewards?epochs=10'],
  ['tvl-info.json',   'https://api.marinade.finance/tlv'],
  ['blacklist.csv',   'https://thru.marinade.finance/marinade-finance/delegation-strategy-2/master/blacklist.csv'],
  ['auctions.json',   'https://scoring.marinade.finance/api/v1/scores/sam?lastEpochs=10'],
];

async function fetchLiveBonds() {
  const ok = await downloadFile(
    'https://validator-bonds-api.marinade.finance/bonds/bidding',
    `${CACHE_DIR}/bonds.json`, 30000);
  log(ok ? '✓ bonds.json refreshed' : '⚠️ bonds.json fetch 실패 — 캐시 유지');
}

async function fetchHeavyIfStale(force = false) {
  const need = force || HEAVY_FILES.some(([f]) => !freshWithin(`${CACHE_DIR}/${f}`, HEAVY_CACHE_TTL));
  if (!need) { log('Heavy 캐시 fresh — skip'); return; }

  log('Heavy 캐시 refresh 중 (30~60초)...');
  for (const [file, url] of HEAVY_FILES) {
    await downloadFile(url, `${CACHE_DIR}/${file}`);
  }
  const cfgSrc = `${PIPELINE_DIR}/auction-config.json`;
  if (existsSync(cfgSrc)) copyFileSync(cfgSrc, `${CACHE_DIR}/config.json`);
  log('✓ Heavy 캐시 refresh 완료');
}

// ============================================================
// ds-sam 실행
// ============================================================
function runDsSam() {
  log('ds-sam 실행 중...');
  const start = Date.now();
  const r = spawnSync('pnpm', ['run', 'cli', '--', 'auction',
    '-c',                  `${CACHE_DIR}/config.json`,
    '--inputs-source',     'FILES',
    '--cache-dir-path',    CACHE_DIR,
    '-o',                  OUTPUT_DIR,
  ], { cwd: DSSAM_DIR });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (r.status !== 0) {
    log(`❌ ds-sam 실패 (${elapsed}s): ${r.stderr.toString().slice(-500)}`);
    return false;
  }
  log(`✓ ds-sam 완료 (${elapsed}s)`);
  return true;
}

function extractMyStatus() {
  const f = `${OUTPUT_DIR}/results.json`;
  if (!existsSync(f)) return null;
  const data = JSON.parse(readFileSync(f, 'utf8'));
  const me = data.auctionData?.validators?.find(v => v.voteAccount === VOTE_ADDR);
  if (!me) return null;
  return {
    epoch:               data.epoch,
    voteAccount:         me.voteAccount,
    bidPmpe:             me.revShare.bidPmpe,
    effPart:             me.revShare.effParticipatingBidPmpe,
    totalPmpe:           me.revShare.totalPmpe,
    bondObligation:      me.revShare.bondObligationPmpe,
    bidTooLowPenalty:    me.revShare.bidTooLowPenaltyPmpe,
    winningTotalPmpe:    data.winningTotalPmpe,
    cutoffMargin:        me.revShare.totalPmpe - data.winningTotalPmpe,
    samTargetSol:        me.auctionStake?.marinadeSamTargetSol ?? 0,
    marinadeStakeSol:    me.marinadeActivatedStakeSol,
    bondBalanceSol:      me.bondBalanceSol,
    samEligible:         me.samEligible,
    lastCapConstraint:   me.lastCapConstraint?.constraintType ?? null,
  };
}

// ============================================================
// bid 결정 + 적용
// ============================================================
function computeTargetBid(effPart) {
  const safeFloor    = effPart * (1 - PERMITTED_DEV);
  const winningFloor = effPart + WIN_BUFFER_PMPE;
  const conservative = effPart * SAFETY_RATIO;
  return +Math.max(safeFloor, winningFloor, conservative).toFixed(4);
}

function readOnchainBond() {
  const r = spawnSync('validator-bonds', ['show-bond', VOTE_ADDR]);
  if (r.status !== 0) return null;
  const m = r.stdout.toString().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const cpmpeStr = j.account?.costPerMillePerEpoch || '';
    const maxStr   = j.account?.maxStakeWanted || '';
    return {
      bid:      parseInt(cpmpeStr.replace(/[^0-9]/g, '')) / 1e9,
      maxStake: parseFloat(maxStr.replace(/[^0-9.]/g, '')),
    };
  } catch { return null; }
}

function applyBid(newBid, maxStake) {
  const cpmpeLamports    = Math.round(newBid * 1e9);
  const maxStakeLamports = Math.round(maxStake * 1e9);
  if (dryRunActive) {
    log(`🔍 DRY_RUN: validator-bonds configure-bond ${VOTE_ADDR} --cpmpe ${cpmpeLamports} --max-stake-wanted ${maxStakeLamports}`);
    return true;
  }
  log(`🚀 적용: bid=${newBid} maxStake=${maxStake}`);
  const r = spawnSync('validator-bonds', ['configure-bond', VOTE_ADDR,
    '--authority', AUTH_FILE,
    '--cpmpe',     String(cpmpeLamports),
    '--max-stake-wanted', String(maxStakeLamports),
    '-k',          KEYPAIR_FILE,
    '--force',
  ], { stdio: 'inherit' });
  return r.status === 0;
}

// ============================================================
// 메인 1회 실행
// ============================================================
async function runOnce() {
  log(`=== bid-bot 시작 (validator: ${VOTE_ADDR.slice(0, 8)}...) ===`);

  ensureDsSamReady();

  await fetchLiveBonds();
  await fetchHeavyIfStale(FORCE_REFRESH);

  if (!runDsSam()) {
    await notifyDiscord('❌ `bid-bot`: ds-sam 실행 실패');
    return;
  }

  const status = extractMyStatus();
  if (!status) {
    log('❌ validator가 결과에 없음');
    await notifyDiscord(`🚨 \`bid-bot\`: validator ${VOTE_ADDR} auction에 없음`);
    return;
  }

  log(`Epoch ${status.epoch} | effPart=${status.effPart} winning=${status.winningTotalPmpe} my=${status.totalPmpe}`);
  log(`  bid=${status.bidPmpe} penalty=${status.bidTooLowPenalty} samTarget=${status.samTargetSol}`);
  log(`  cutoffMargin=${status.cutoffMargin} eligible=${status.samEligible}`);

  if (MODE === 'status') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status.samEligible) {
    log('⚠️ samEligible=false');
    await notifyDiscord('⚠️ `bid-bot`: samEligible=false 점검 필요');
    return;
  }

  let target = computeTargetBid(status.effPart);
  if (target < MIN_SANITY_BID || target > MAX_SANITY_BID) {
    log(`⚠️ target=${target} sanity 범위 밖`);
    return;
  }

  const onchain = readOnchainBond();
  if (!onchain) { log('❌ on-chain 조회 실패'); return; }
  log(`on-chain: bid=${onchain.bid} maxStake=${onchain.maxStake}`);

  const delta = Math.abs(onchain.bid - target);
  log(`  target=${target} delta=${delta.toFixed(6)}`);

  if (delta < MIN_BID_CHANGE_PMPE) {
    log(`✅ 변경 불필요 (delta < ${MIN_BID_CHANGE_PMPE})`);
    if (status.bidTooLowPenalty > 0) {
      log(`⚠️ 페널티 ${status.bidTooLowPenalty} 발생 중`);
      await notifyDiscord(`⚠️ \`bid-bot\`: 페널티 \`${status.bidTooLowPenalty}\` 발생 중. 수동 점검 필요`);
    }
    return;
  }

  if (onchain.bid > target && delta > MAX_SINGLE_DROP) {
    const capped = +(onchain.bid - MAX_SINGLE_DROP).toFixed(4);
    log(`⚠️ 큰 폭 인하 ${target} → ${capped}`);
    target = capped;
    if (target < status.effPart) {
      log('❌ 제한 후 effPart 아래');
      await notifyDiscord(`⚠️ \`bid-bot\`: 큰 폭 인하 (${onchain.bid} → ${target})`);
      return;
    }
  }

  log(`🎯 적용: ${onchain.bid} → ${target}`);
  if (applyBid(target, onchain.maxStake)) {
    await notifyDiscord(`✅ \`bid-bot\`: bid \`${onchain.bid}\` → \`${target}\` PMPE (effPart=\`${status.effPart}\` epoch=${status.epoch})`);
    writeFileSync(STATE_FILE, JSON.stringify({
      last_bid: target, last_change_at: new Date().toISOString(), epoch: status.epoch,
    }, null, 2));
  } else {
    await notifyDiscord('❌ `bid-bot`: bid 적용 실패');
  }
}

// ============================================================
// CLI
// ============================================================
async function checkPrereqs() {
  for (const cmd of ['curl', 'git', 'node', 'validator-bonds']) {
    if (!which(cmd)) die(`${cmd} 필요. 시스템에 설치 후 재시도`);
  }
  if (!VOTE_ADDR) die('voteAccount 미설정. bid-bot.json의 validator.voteAccount를 입력하세요');
  if (!AUTH_FILE) die('authFile 미설정. bid-bot.json의 validator.authFile을 입력하세요');
  if (!KEYPAIR_FILE) die('keypairFile 미설정. bid-bot.json의 validator.keypairFile을 입력하세요');
  if (!existsSync(AUTH_FILE)) die(`authority file 없음: ${AUTH_FILE}`);
  if (!existsSync(KEYPAIR_FILE)) die(`keypair file 없음: ${KEYPAIR_FILE}`);
}

(async () => {
  if (MODE === 'setup') {
    ensurePnpm();
    ensureDsSamReady();
    log('✅ Setup 완료');
    return;
  }
  await checkPrereqs();
  if (MODE === 'loop') {
    log(`Loop mode (interval ${LOOP_INTERVAL/1000}s)`);
    while (true) {
      try { await runOnce(); } catch (e) { log(`Error: ${e.stack || e.message}`); }
      log(`다음 체크까지 ${LOOP_INTERVAL/1000}s 대기`);
      await new Promise(r => setTimeout(r, LOOP_INTERVAL));
    }
  } else {
    try { await runOnce(); } catch (e) { log(`Error: ${e.stack || e.message}`); process.exit(1); }
  }
})();
