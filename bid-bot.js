#!/usr/bin/env node
// bid-bot.js — Marinade SAM 자동 bid 관리 (Node.js single-file)
//
// 모드:
//   node bid-bot.js              # 1회 실행 (pm2 cron용)
//   node bid-bot.js --setup      # ds-sam clone + install (자동)
//   node bid-bot.js --status     # 현재 상태만 JSON 출력
//   node bid-bot.js --fill-rank  # live 재계산 기준 stake fill 순위표
//   node bid-bot.js --loop --fill-rank --rank-limit 9  # loop 중 Discord fill-rank 알림
//   node bid-bot.js --dry-run    # 변경 시뮬레이션만
//   node bid-bot.js --loop       # 무한 루프
//   node bid-bot.js --force-refresh  # heavy 캐시 강제 갱신

import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  statSync, mkdirSync, renameSync, copyFileSync,
  accessSync, constants,
} from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 설정 로드 (우선순위: env > BID_BOT_CONFIG/bid-bot.json > default)
// ============================================================
const CONFIG_PATH = process.env.BID_BOT_CONFIG || resolve(__dirname, 'bid-bot.json');
const CONFIG_HELP = process.env.BID_BOT_CONFIG
  ? `설정 파일 확인 필요: ${CONFIG_PATH}`
  : 'bid-bot.example.json을 bid-bot.json으로 복사한 뒤 validator 값을 입력하세요';
const userCfg = existsSync(CONFIG_PATH)
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  : {};

function get(envVar, jsonPath, defaultVal) {
  if (process.env[envVar] !== undefined) return process.env[envVar];
  return getJson(jsonPath) ?? defaultVal;
}
function getJson(jsonPath) {
  let v = userCfg;
  for (const p of jsonPath.split('.')) {
    if (v == null || typeof v !== 'object') { v = undefined; break; }
    v = v[p];
  }
  return v;
}
const rel = (p) => p ? resolve(__dirname, p) : '';

const VOTE_ADDR     = get('VOTE_ADDR',     'validator.voteAccount', '');
const BOND_ADDR     = get('BOND_ADDR',     'validator.bondAccount', '');
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
// bid-too-low 페널티 방지: 최근 N 에폭 동안의 내 bidPmpe 최소값 × multiplier를 floor로 사용
const RECENT_MIN_LOOKBACK_EPOCHS = +get('RECENT_MIN_LOOKBACK_EPOCHS', 'bidStrategy.recentMinLookbackEpochs', 4);
const RECENT_MIN_MULTIPLIER      = +get('RECENT_MIN_MULTIPLIER',      'bidStrategy.recentMinMultiplier',     1.03);

const LOG_FILE        = rel(get('LOG_FILE',   'logging.logFile',   './bid-bot.log'));
const STATE_FILE      = rel(get('STATE_FILE', 'logging.stateFile', './bid-bot.state'));
const DISCORD_WEBHOOK = get('DISCORD_WEBHOOK', 'logging.discordWebhook', '');

const DRY_RUN       = String(get('DRY_RUN',       'runtime.dryRun', false)).toLowerCase() === 'true';
const LOOP_INTERVAL = +get('LOOP_INTERVAL', 'runtime.loopInterval', 300) * 1000;
const DSSAM_TIMEOUT_MS = +get('DSSAM_TIMEOUT_MS', 'runtime.dsSamTimeoutMs', 5 * 60 * 1000);
const BOND_CLI_TIMEOUT_MS = +get('BOND_CLI_TIMEOUT_MS', 'runtime.bondCliTimeoutMs', 60 * 1000);
const SETUP_COMMAND_TIMEOUT_MS = +get('SETUP_COMMAND_TIMEOUT_MS', 'runtime.setupCommandTimeoutMs', 15 * 60 * 1000);
const SOLANA_RPC_URL = get('SOLANA_RPC_URL', 'runtime.epochAware.solanaRpcUrl', 'https://api.mainnet-beta.solana.com');
const EPOCH_AWARE_LOOP = String(get('EPOCH_AWARE_LOOP', 'runtime.epochAware.enabled', true)).toLowerCase() === 'true';
const EPOCH_FAST_THRESHOLD_SECONDS = +get('EPOCH_FAST_THRESHOLD_SECONDS', 'runtime.epochAware.thresholdSeconds', 3600);
const EPOCH_FAST_INTERVAL = +get('EPOCH_FAST_INTERVAL_SECONDS', 'runtime.epochAware.fastLoopIntervalSeconds', 300) * 1000;
const EPOCH_RPC_TIMEOUT_MS = +get('EPOCH_RPC_TIMEOUT_MS', 'runtime.epochAware.rpcTimeoutMs', 10000);
const VALIDATOR_NAME_LOOKUP_URL = 'https://validators-api.marinade.finance/validators?epochs=1&limit=1000000';
const VALIDATOR_NAME_TIMEOUT_MS = +get('VALIDATOR_NAME_TIMEOUT_MS', 'runtime.validatorNameTimeoutMs', 10000);
const FILL_RANK_DISCORD_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const args = process.argv.slice(2);
function resolveMode(argv) {
  if (argv.includes('--setup')) return 'setup';
  if (argv.includes('--status')) return 'status';
  if (argv.includes('--loop')) return 'loop';
  if (argv.includes('--fill-rank')) return 'fill-rank';
  return 'run';
}
const FILL_RANK_REQUESTED = args.includes('--fill-rank');
const MODE = resolveMode(args);
const FORCE_REFRESH = args.includes('--force-refresh');
const FORCE_DRY     = args.includes('--dry-run');
function readNumberArg(name, defaultValue) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1));
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] != null) return Number(args[index + 1]);
  return defaultValue;
}
const FILL_RANK_LIMIT = readNumberArg('--rank-limit', 9);
const dryRunActive  = DRY_RUN || FORCE_DRY;
const verboseLogs   = dryRunActive;
const showCalculationTable = dryRunActive || MODE === 'loop';
const loopFillRankReports = MODE === 'loop' && FILL_RANK_REQUESTED;
let discordValidatorLabel = '';

// ============================================================
// 유틸
// ============================================================
function log(msg) {
  const ts = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19) + ' KST';
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function logVerbose(msg) {
  if (verboseLogs) log(msg);
}
function die(msg) { log(`❌ 중단합니다. ${msg}`); process.exit(1); }

function fmt4(n) {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}
function fmtPmpe(n) {
  return `${fmt4(n)} PMPE`;
}
function fmtSol(n) {
  return Number.isFinite(n)
    ? `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SOL`
    : `${n} SOL`;
}
function fmtSol0(n) {
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : String(n);
}
function fmtPct0(n) {
  return Number.isFinite(n)
    ? `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`
    : String(n);
}
function calcPmpeAfterCommission(pmpe, commissionDec) {
  if (!Number.isFinite(pmpe) || pmpe <= 0) return 0;
  if (!Number.isFinite(commissionDec) || commissionDec >= 1) return 0;
  return Math.max(0, pmpe * (1 - commissionDec));
}
function fmtAccount(addr) {
  return addr && addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}
function fmtPenalty(n) {
  return Number.isFinite(n) && n > 0 ? fmtPmpe(n) : '없음';
}
function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분`;
  return `${secs}초`;
}
function formatTable(title, rows) {
  const labelWidth = Math.max('Item'.length, ...rows.map(([label]) => label.length));
  const valueWidth = Math.max('Value'.length, ...rows.map(([, value]) => String(value).length));
  const hr = `${'-'.repeat(labelWidth)}  ${'-'.repeat(valueWidth)}`;
  return [
    title,
    `${'Item'.padEnd(labelWidth)}  ${'Value'.padEnd(valueWidth)}`,
    hr,
    ...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${String(value).padEnd(valueWidth)}`),
  ].join('\n');
}
function isWideCodePoint(code) {
  return (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )
  );
}
function displayWidth(value) {
  return Array.from(String(value ?? '')).reduce((width, ch) => {
    const code = ch.codePointAt(0);
    if (code < 32 || (code >= 0x7f && code < 0xa0)) return width;
    return width + (isWideCodePoint(code) ? 2 : 1);
  }, 0);
}
function padDisplay(value, width, align = 'left') {
  const text = String(value ?? '');
  const padding = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'right' ? padding + text : text + padding;
}
function formatAlignedTable(headers, rows, opts = {}) {
  const aligns = opts.aligns ?? headers.map(() => 'left');
  const stringRows = rows.map(row => row.map(value => String(value ?? '')));
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...stringRows.map(row => displayWidth(row[index] ?? '')),
  ));
  const formatRow = row => row
    .map((value, index) => (
      index === row.length - 1
        ? String(value ?? '')
        : padDisplay(value, widths[index], aligns[index])
    ))
    .join('  ');
  return [
    formatRow(headers),
    widths.map(width => '-'.repeat(width)).join('  '),
    ...stringRows.map(formatRow),
  ].join('\n');
}
function formatBidCalculationTable(status, onchainBid, targetBid, opts = {}) {
  const delta = Math.abs(onchainBid - targetBid);
  const rows = [
    ['Epoch', status.epoch],
    ['Eligible', status.samEligible ? 'Yes' : 'No'],
    ['Winning PMPE', fmtPmpe(status.winningTotalPmpe)],
    ['My Total PMPE', fmtPmpe(status.totalPmpe)],
    ['Winning Margin', fmtPmpe(status.cutoffMargin)],
    ['EffPart', fmtPmpe(status.effPart)],
    ['Current Bid', fmtPmpe(onchainBid)],
    ['Target Bid', fmtPmpe(targetBid)],
    ['Bid Change', `${fmtPmpe(onchainBid)} -> ${fmtPmpe(targetBid)}`],
    ['Delta', fmtPmpe(delta)],
    ['Current CPMPE', pmpeToCpmpeLamports(onchainBid)],
    ['Target CPMPE', pmpeToCpmpeLamports(targetBid)],
    ['Penalty', fmtPenalty(status.bidTooLowPenalty)],
    ['SAM Target', fmtSol(status.samTargetSol)],
  ];
  if (Number.isFinite(opts.recentMinFloor) && opts.recentMinFloor > 0) {
    rows.splice(8, 0, [`Recent${RECENT_MIN_LOOKBACK_EPOCHS}MinFloor`, fmtPmpe(opts.recentMinFloor)]);
  }
  if (opts.includeMinChange) {
    rows.splice(rows.findIndex(r => r[0] === 'Delta'), 0, ['Min Change', fmtPmpe(MIN_BID_CHANGE_PMPE)]);
  }
  return formatTable(opts.title ?? '계산 결과', rows);
}

function pmpeToCpmpeLamports(pmpe) {
  const lamports = Math.round(Number(pmpe) * 1e9);
  return Number.isFinite(lamports) ? lamports : null;
}

function parseCpmpeBid(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const bid = Number.parseInt(digits, 10) / 1e9;
  return Number.isFinite(bid) ? bid : null;
}

function cleanValidatorName(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  return text || null;
}

function findValidatorNameByVoteAccount(data, voteAccount) {
  if (!voteAccount || !data) return null;
  const lists = [
    Array.isArray(data) ? data : null,
    Array.isArray(data.validators) ? data.validators : null,
    Array.isArray(data.validators_aggregated) ? data.validators_aggregated : null,
    Array.isArray(data.auctionData?.validators) ? data.auctionData.validators : null,
  ].filter(Boolean);
  const voteFields = ['vote_account', 'voteAccount', 'vote_account_address', 'votePubkey'];
  const nameFields = ['info_name', 'name', 'moniker', 'validatorName', 'validator_name'];

  for (const validators of lists) {
    for (const validator of validators) {
      if (!voteFields.some((field) => validator?.[field] === voteAccount)) continue;
      for (const field of nameFields) {
        const name = cleanValidatorName(validator?.[field]);
        if (name) return name;
      }
    }
  }
  return null;
}

function formatDiscordContent(content, validatorName = discordValidatorLabel) {
  const label = cleanValidatorName(validatorName);
  return label ? `[${label}] ${content}` : content;
}
function formatDiscordCodeBlockMessages(title, body, opts = {}) {
  const maxChars = opts.maxChars ?? 1800;
  const lines = String(body ?? '').split('\n');
  const messages = [];
  let chunk = [];

  const render = (part, index) => {
    const suffix = index > 0 ? ` (${index + 1})` : '';
    return `${title}${suffix}\n\`\`\`text\n${part.join('\n')}\n\`\`\``;
  };

  for (const line of lines) {
    const candidate = [...chunk, line];
    if (chunk.length > 0 && render(candidate, messages.length).length > maxChars) {
      messages.push(render(chunk, messages.length));
      chunk = [line];
    } else {
      chunk = candidate;
    }
  }
  if (chunk.length > 0) {
    messages.push(render(chunk, messages.length));
  }
  return messages;
}

function readCachedValidatorName(voteAccount) {
  const file = `${CACHE_DIR}/validators.json`;
  if (!existsSync(file)) return null;
  try {
    return findValidatorNameByVoteAccount(JSON.parse(readFileSync(file, 'utf8')), voteAccount);
  } catch {
    return null;
  }
}

async function fetchValidatorName(voteAccount) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATOR_NAME_TIMEOUT_MS);
  try {
    const resp = await fetch(VALIDATOR_NAME_LOOKUP_URL, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return findValidatorNameByVoteAccount(await resp.json(), voteAccount);
  } catch (e) {
    logVerbose(`validator 이름 조회에 실패했습니다. 이유: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function initDiscordValidatorLabel() {
  if (!VOTE_ADDR) return;
  const name = readCachedValidatorName(VOTE_ADDR) ?? await fetchValidatorName(VOTE_ADDR);
  discordValidatorLabel = name ?? fmtAccount(VOTE_ADDR);
  if (name) {
    logVerbose(`validator 이름을 확인했습니다. name: ${name}`);
  } else {
    logVerbose(`validator 이름을 찾지 못해 Discord prefix는 ${discordValidatorLabel}로 표시합니다.`);
  }
}

async function notifyDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: formatDiscordContent(content) }),
    });
  } catch (e) { log(`Discord 알림을 보내지 못했습니다. 이유: ${e.message}`); }
}

function which(cmd) {
  const canExecute = (file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return canExecute(cmd);
  return (process.env.PATH || '')
    .split(':')
    .some((dir) => canExecute(resolve(dir || '.', cmd)));
}
function timedOut(result) {
  return result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
}
function spawnSetupCommand(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    ...opts,
    timeout: opts.timeout ?? SETUP_COMMAND_TIMEOUT_MS,
  });
  if (timedOut(result)) {
    log(`❌ setup 명령이 시간 안에 끝나지 않았습니다. 명령: ${cmd} ${args.join(' ')}`);
  }
  return result;
}
function pnpmEnv(extra = {}) {
  return {
    ...process.env,
    CI: process.env.CI || 'true',
    COREPACK_ENABLE_AUTO_PIN: process.env.COREPACK_ENABLE_AUTO_PIN || '0',
    npm_config_engine_strict: 'false',
    npm_config_confirm_modules_purge: 'false',
    ...extra,
  };
}
function patchDsSamSdkForPrereleaseVersions(source) {
  const target = 'semver.satisfies(validator.clientVersion, this.config.validatorsClientVersionSemverExpr)';
  const replacement = 'semver.satisfies(validator.clientVersion, this.config.validatorsClientVersionSemverExpr, { includePrerelease: true })';
  if (source.includes(replacement)) return { source, patched: false, alreadyPatched: true };
  if (!source.includes(target)) return { source, patched: false, alreadyPatched: false };
  return {
    source: source.replace(target, replacement),
    patched: true,
    alreadyPatched: false,
  };
}
function applyDsSamCompatibilityPatches() {
  const sdkPath = `${DSSAM_DIR}/packages/ds-sam-sdk/src/sdk.ts`;
  if (!existsSync(sdkPath)) return false;
  const original = readFileSync(sdkPath, 'utf8');
  const result = patchDsSamSdkForPrereleaseVersions(original);
  if (!result.patched) {
    if (!result.alreadyPatched) {
      log('⚠️ ds-sam client version 체크 패치를 적용하지 못했습니다. Firedancer rc 버전이 SAM eligibility에서 제외될 수 있습니다.');
    }
    return false;
  }
  writeFileSync(sdkPath, result.source);
  log('ds-sam client version 체크를 Firedancer rc 버전까지 허용하도록 패치했습니다.');
  return true;
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
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest + '.tmp', buf);
    renameSync(dest + '.tmp', dest);
    return true;
  } catch (e) {
    log(`데이터를 내려받지 못했습니다. URL=${url}, 이유=${e.message}`);
    return false;
  } finally { clearTimeout(timer); }
}

async function rpcCall(method, params = []) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EPOCH_RPC_TIMEOUT_MS);
  try {
    const resp = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function getEpochTiming() {
  const [epochInfo, samples] = await Promise.all([
    rpcCall('getEpochInfo'),
    rpcCall('getRecentPerformanceSamples', [5]),
  ]);
  return calculateEpochTiming(epochInfo, samples);
}

function calculateEpochTiming(epochInfo, samples) {
  const slotsRemaining = Math.max(0, Number(epochInfo.slotsInEpoch) - Number(epochInfo.slotIndex));
  const sampleSecs = samples.reduce((sum, s) => sum + Number(s.samplePeriodSecs || 0), 0);
  const sampleSlots = samples.reduce((sum, s) => sum + Number(s.numSlots || 0), 0);
  const slotsPerSecond = sampleSlots / sampleSecs;
  if (!Number.isFinite(slotsPerSecond) || slotsPerSecond <= 0) {
    throw new Error('최근 slot 처리 속도를 계산할 수 없습니다');
  }
  return {
    epoch: epochInfo.epoch,
    slotsRemaining,
    slotsPerSecond,
    remainingSeconds: slotsRemaining / slotsPerSecond,
  };
}

function chooseLoopDelayMs(timing, opts = {}) {
  const epochAwareLoop = opts.enabled ?? EPOCH_AWARE_LOOP;
  const loopIntervalMs = opts.loopIntervalMs ?? LOOP_INTERVAL;
  const fastThresholdSeconds = opts.thresholdSeconds ?? EPOCH_FAST_THRESHOLD_SECONDS;
  const fastIntervalMs = opts.fastLoopIntervalMs ?? EPOCH_FAST_INTERVAL;
  if (!epochAwareLoop) return { delayMs: loopIntervalMs, fastMode: false };
  if (timing.remainingSeconds <= fastThresholdSeconds) {
    return { delayMs: Math.min(loopIntervalMs, fastIntervalMs), fastMode: true };
  }
  return { delayMs: loopIntervalMs, fastMode: false };
}

async function nextLoopDelayMs() {
  if (!EPOCH_AWARE_LOOP) return LOOP_INTERVAL;
  try {
    const timing = await getEpochTiming();
    const decision = chooseLoopDelayMs(timing);
    if (decision.fastMode) {
      logVerbose(`Solana epoch ${timing.epoch} 종료까지 약 ${fmtDuration(timing.remainingSeconds)} 남았습니다. 임박 구간이라 다음 확인은 ${fmtDuration(decision.delayMs / 1000)} 후입니다.`);
      return decision.delayMs;
    }
    logVerbose(`Solana epoch ${timing.epoch} 종료까지 약 ${fmtDuration(timing.remainingSeconds)} 남았습니다. 다음 확인은 기본 주기 ${fmtDuration(LOOP_INTERVAL / 1000)} 후입니다.`);
    return decision.delayMs;
  } catch (e) {
    log(`Solana epoch 남은 시간을 확인하지 못했습니다. 기본 주기 ${fmtDuration(LOOP_INTERVAL / 1000)}로 대기합니다. 이유: ${e.message}`);
    return LOOP_INTERVAL;
  }
}

// ============================================================
// pnpm 자동 설치
// ============================================================
function ensurePnpm() {
  if (which('pnpm')) return;
  log('pnpm이 없어 자동 설치를 시도합니다.');

  // 1. corepack (Node 16.10+ 내장, 권장)
  if (which('corepack')) {
    log('corepack으로 pnpm을 준비합니다.');
    spawnSetupCommand('corepack', ['enable'], { stdio: 'inherit' });
    spawnSetupCommand('corepack', ['prepare', 'pnpm@latest', '--activate'], { stdio: 'inherit' });
    if (which('pnpm')) { log('pnpm 설치가 끝났습니다. 설치 방식: corepack'); return; }
  }

  // 2. npm install -g
  if (which('npm')) {
    log('npm으로 pnpm 전역 설치를 시도합니다.');
    const r = spawnSetupCommand('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
    if (r.status === 0 && which('pnpm')) { log('pnpm 설치가 끝났습니다. 설치 방식: npm'); return; }
  }

  // 3. standalone
  if (which('curl')) {
    log('pnpm standalone installer를 시도합니다.');
    const r = spawnSetupCommand('sh', ['-c', 'curl -fsSL https://get.pnpm.io/install.sh | sh -'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.env.PATH = `${process.env.HOME}/.local/share/pnpm:${process.env.PATH}`;
      if (which('pnpm')) { log('pnpm 설치가 끝났습니다. 설치 방식: standalone installer'); return; }
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
  const buildReady = existsSync(`${DSSAM_DIR}/dist`)
                  && existsSync(`${DSSAM_DIR}/packages/ds-sam-sdk/dist`);
  const need = !existsSync(DSSAM_DIR)
            || !existsSync(`${DSSAM_DIR}/node_modules`)
            || !existsSync(PIPELINE_DIR)
            || !existsSync(`${PIPELINE_DIR}/auction-config.json`)
            || !buildReady;
  for (const d of [CACHE_DIR, OUTPUT_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  if (need) {
    for (const cmd of ['git', 'node', 'curl']) {
      if (!which(cmd)) die(`${cmd} 필요. 시스템에 설치하세요`);
    }
  }
  ensurePnpm();

  if (need) {
    log('ds-sam 실행 환경이 아직 준비되지 않아 자동 setup을 시작합니다.');
    notifyDiscord('🔧 `bid-bot`: ds-sam 자동 설치 시작 (5~10분)');
  }

  if (!existsSync(DSSAM_DIR)) {
    log(`ds-sam 저장소를 받습니다. 위치: ${DSSAM_DIR}`);
    if (spawnSetupCommand('git', ['clone', 'https://github.com/marinade-finance/ds-sam.git', DSSAM_DIR],
                  { stdio: 'inherit' }).status !== 0) die('clone 실패');
  }
  if (!existsSync(PIPELINE_DIR)) {
    log(`ds-sam-pipeline 저장소를 받습니다. 위치: ${PIPELINE_DIR}`);
    if (spawnSetupCommand('git', ['clone', 'https://github.com/marinade-finance/ds-sam-pipeline.git', PIPELINE_DIR],
                  { stdio: 'inherit' }).status !== 0) die('clone 실패');
  }

  if (!existsSync(`${DSSAM_DIR}/node_modules`)) {
    log('ds-sam 의존성을 설치합니다. 보통 5~10분 걸립니다.');
    if (spawnSetupCommand('pnpm', ['install', '--frozen-lockfile', '--config.engine-strict=false', '--ignore-scripts'],
                  { cwd: DSSAM_DIR, stdio: 'inherit', env: pnpmEnv() }).status !== 0)
      die('pnpm install 실패');
  }
  const patched = applyDsSamCompatibilityPatches();
  if (!need && !patched) return;
  if (!buildReady || patched) {
    log('ds-sam을 빌드합니다.');
    if (spawnSetupCommand('pnpm', ['--config.verify-deps-before-run=false', '-r', 'build'],
                  { cwd: DSSAM_DIR, stdio: 'inherit', env: pnpmEnv() }).status !== 0)
      die('build 실패');
  }

  notifyDiscord(`✅ \`bid-bot\`: ds-sam ${need ? '설치' : '패치'} 완료`);
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
  if (ok) {
    logVerbose('최신 bond 입찰 데이터를 받았습니다.');
  } else {
    log('최신 bond 입찰 데이터를 받지 못했습니다. 오래된 cache로 적용하지 않기 위해 이번 회차를 중단합니다.');
  }
  return ok;
}

async function fetchHeavyIfStale(force = false) {
  const need = force || HEAVY_FILES.some(([f]) => !freshWithin(`${CACHE_DIR}/${f}`, HEAVY_CACHE_TTL));
  if (!need) { logVerbose('검증용 보조 데이터 cache가 아직 유효해서 다시 받지 않습니다.'); return true; }

  logVerbose('검증용 보조 데이터를 새로 받습니다. 보통 30~60초 걸립니다.');
  const failedFiles = await refreshHeavyFiles(HEAVY_FILES, CACHE_DIR);
  if (failedFiles.length > 0) {
    log(`검증용 보조 데이터 갱신에 실패했습니다. 실패 파일: ${failedFiles.join(', ')}. 오래된 cache로 계산하지 않기 위해 이번 회차를 중단합니다.`);
    return false;
  }
  const cfgSrc = `${PIPELINE_DIR}/auction-config.json`;
  if (existsSync(cfgSrc)) copyFileSync(cfgSrc, `${CACHE_DIR}/config.json`);
  logVerbose('검증용 보조 데이터 갱신이 끝났습니다.');
  return true;
}

async function refreshHeavyFiles(files, cacheDir, downloader = downloadFile) {
  const failedFiles = [];
  for (const [file, url] of files) {
    if (!(await downloader(url, `${cacheDir}/${file}`))) {
      failedFiles.push(file);
    }
  }
  return failedFiles;
}

// ============================================================
// ds-sam 실행
// ============================================================
function runDsSam() {
  logVerbose('Marinade SAM 경매 계산을 실행합니다.');
  const start = Date.now();
  const r = spawnSync('pnpm', ['--config.verify-deps-before-run=false', 'run', 'cli', '--', 'auction',
    '-c',                  `${CACHE_DIR}/config.json`,
    '--inputs-source',     'FILES',
    '--cache-dir-path',    CACHE_DIR,
    '-o',                  OUTPUT_DIR,
  ], {
    cwd: DSSAM_DIR,
    timeout: DSSAM_TIMEOUT_MS,
    env: pnpmEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (timedOut(r)) {
    log(`❌ Marinade SAM 계산이 ${elapsed}초 동안 끝나지 않아 중단했습니다.`);
    return false;
  }
  if (r.error) {
    log(`❌ Marinade SAM 계산을 시작하지 못했습니다. 걸린 시간: ${elapsed}초, 이유: ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    log(`❌ Marinade SAM 계산이 실패했습니다. 걸린 시간: ${elapsed}초, 마지막 오류: ${(r.stderr || '').toString().slice(-500)}`);
    return false;
  }
  logVerbose(`Marinade SAM 경매 계산이 끝났습니다. 걸린 시간: ${elapsed}초`);
  return true;
}

function extractMyStatus() {
  const f = `${OUTPUT_DIR}/results.json`;
  if (!existsSync(f)) return null;
  const data = JSON.parse(readFileSync(f, 'utf8'));
  return extractMyStatusFromResults(data, VOTE_ADDR);
}

function extractMyStatusFromResults(data, voteAccount) {
  const me = data.auctionData?.validators?.find(v => v.voteAccount === voteAccount);
  if (!me) return null;
  return {
    epoch:               data.auctionData?.epoch,
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

function computeFillRankRowsFromResults(data, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 9;
  const validators = data.auctionData?.validators ?? [];
  const rewards = data.auctionData?.rewards ?? {};
  const normalizedOnchainPmpe =
    calcPmpeAfterCommission(Number(rewards.inflationPmpe), 0.05) +
    calcPmpeAfterCommission(Number(rewards.mevPmpe), 0);
  const tvl = data.auctionData?.stakeAmounts?.marinadeSamTvlSol ?? 0;
  const activeTotal = validators.reduce((sum, validator) => sum + Number(validator.marinadeActivatedStakeSol ?? 0), 0);
  const redelegateBudget = Math.max(0, tvl - activeTotal);
  const ranked = validators
    .map((validator, sourceIndex) => {
      const target = Number(validator.auctionStake?.marinadeSamTargetSol ?? 0);
      const active = Number(validator.marinadeActivatedStakeSol ?? 0);
      return {
        sourceIndex,
        voteAccount: validator.voteAccount,
        stakePriority: validator.stakePriority,
        target,
        active,
        need: target - active,
        bidPmpe: validator.revShare?.bidPmpe,
        normalizedBidPmpe: Number.isFinite(validator.revShare?.totalPmpe)
          ? Math.max(0, validator.revShare.totalPmpe - normalizedOnchainPmpe)
          : null,
        constraint: validator.lastCapConstraint?.constraintType ?? null,
      };
    })
    .filter(row => Number.isFinite(row.stakePriority) && row.stakePriority > 0)
    .sort((a, b) => a.stakePriority - b.stakePriority || a.sourceIndex - b.sourceIndex)
    .filter(row => row.need > 1e-9);

  let remaining = redelegateBudget;
  const rows = ranked.map((row, index) => {
    const fill = Math.min(row.need, Math.max(0, remaining));
    remaining -= fill;
    return {
      rank: index + 1,
      ...row,
      fill,
      fillPct: row.need > 0 ? fill / row.need : 1,
      remainingAfter: Math.max(0, remaining),
    };
  });

  return {
    epoch: data.auctionData?.epoch,
    tvl,
    activeTotal,
    redelegateBudget,
    receiverCount: rows.length,
    rows: rows.slice(0, limit),
    allRows: rows,
  };
}

function formatFillRankTable(result) {
  const summary = [
    `Epoch: ${result.epoch}`,
    `Re-delegate budget: ${fmtSol0(result.redelegateBudget)} SOL`,
    `Receivers: ${result.receiverCount}`,
  ].join('\n');
  const table = formatAlignedTable(
    ['Rank', 'Vote', 'Stake Priority', 'Target', 'Active', '받을 Stake', 'Fill 예상', 'Fill', 'Bid', 'Bid @5/0', 'Constraint'],
    result.rows.map(row => [
      row.rank,
      fmtAccount(row.voteAccount),
      row.stakePriority,
      fmtSol0(row.target),
      fmtSol0(row.active),
      fmtSol0(row.need),
      fmtSol0(row.fill),
      fmtPct0(row.fillPct),
      fmt4(row.bidPmpe),
      fmt4(row.normalizedBidPmpe),
      row.constraint ?? '',
    ]),
    {
      aligns: ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
    },
  );
  return `${summary}\n\n${table}`;
}

function readFillRankTable(limit = FILL_RANK_LIMIT) {
  const data = JSON.parse(readFileSync(`${OUTPUT_DIR}/results.json`, 'utf8'));
  return formatFillRankTable(computeFillRankRowsFromResults(data, { limit }));
}

function shouldCheckScheduledFillRankReport(nowMs, lastCheckedMs, intervalMs = FILL_RANK_DISCORD_CHECK_INTERVAL_MS) {
  return lastCheckedMs == null || nowMs - lastCheckedMs >= intervalMs;
}

function hasFillRankTableChanged(currentTable, lastSentTable) {
  return lastSentTable == null || currentTable !== lastSentTable;
}

async function notifyFillRankReportToDiscord(reason, table = readFillRankTable(FILL_RANK_LIMIT)) {
  const title = `📊 \`bid-bot\`: fill-rank --rank-limit ${FILL_RANK_LIMIT}${reason ? ` (${reason})` : ''}`;
  for (const message of formatDiscordCodeBlockMessages(title, table)) {
    await notifyDiscord(message);
  }
}

// ============================================================
// bid 결정 + 적용
// ============================================================
function computeTargetBid(effPart, strategy = {}) {
  const permittedDev = strategy.permittedDev ?? PERMITTED_DEV;
  const winBufferPmpe = strategy.winBufferPmpe ?? WIN_BUFFER_PMPE;
  const safetyRatio = strategy.safetyRatio ?? SAFETY_RATIO;
  const recentMinFloor = strategy.recentMinFloor ?? 0;
  const safeFloor    = effPart * (1 - permittedDev);
  const winningFloor = effPart + winBufferPmpe;
  const conservative = effPart * safetyRatio;
  return +Math.max(safeFloor, winningFloor, conservative, recentMinFloor).toFixed(4);
}

// scoring.marinade.finance SAM API 응답에서 내 validator의 epoch별 effParticipatingBidPmpe를 추출
function extractMyEffBidsFromAuctions(auctions, voteAccount) {
  if (!Array.isArray(auctions)) return [];
  return auctions
    .filter(a => a?.voteAccount === voteAccount)
    .map(a => ({
      epoch: a.epoch,
      effPart: a.revShare?.effParticipatingBidPmpe,
      bidPmpe: a.revShare?.bidPmpe,
    }))
    .filter(e => Number.isFinite(e.epoch) && Number.isFinite(e.effPart) && e.effPart > 0)
    .sort((a, b) => a.epoch - b.epoch);
}

function computeRecentMinFloor(auctions, voteAccount, currentEpoch) {
  const mine = extractMyEffBidsFromAuctions(auctions, voteAccount);
  if (mine.length === 0) return 0;
  // 현재 epoch은 제외하고 직전 N 에폭의 effParticipatingBidPmpe 최소값 사용
  const past = mine.filter(e => e.epoch !== currentEpoch).slice(-RECENT_MIN_LOOKBACK_EPOCHS);
  if (past.length === 0) return 0;
  const minEff = Math.min(...past.map(e => e.effPart));
  return minEff * RECENT_MIN_MULTIPLIER;
}

function readCachedAuctions() {
  const f = `${CACHE_DIR}/auctions.json`;
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch { return null; }
}

function shouldChangeBid(onchainBid, targetBid, minBidChangePmpe = MIN_BID_CHANGE_PMPE) {
  return Math.abs(onchainBid - targetBid) + Number.EPSILON >= minBidChangePmpe;
}

function isTargetInSanityRange(targetBid, minBid = MIN_SANITY_BID, maxBid = MAX_SANITY_BID) {
  return Number.isFinite(targetBid) && targetBid >= minBid && targetBid <= maxBid;
}

function capSingleDrop(onchainBid, targetBid, effPart, maxSingleDrop = MAX_SINGLE_DROP) {
  const delta = Math.abs(onchainBid - targetBid);
  if (!(onchainBid > targetBid && delta - maxSingleDrop > Number.EPSILON)) {
    return { target: targetBid, capped: false, blocked: false };
  }
  const target = +(onchainBid - maxSingleDrop).toFixed(4);
  return { target, capped: true, blocked: target < effPart };
}

function resolveBondAccount() {
  if (BOND_ADDR) return BOND_ADDR;
  if (!KEYPAIR_FILE || !existsSync(KEYPAIR_FILE)) return null;

  const r = spawnSync('validator-bonds', ['-k', KEYPAIR_FILE, 'bond-address', VOTE_ADDR], {
    timeout: BOND_CLI_TIMEOUT_MS,
  });
  if (timedOut(r)) {
    log('❌ bond account 주소 조회가 시간 안에 끝나지 않았습니다.');
    return null;
  }
  if (r.status !== 0) {
    log(`❌ vote account에서 bond account 주소를 찾지 못했습니다. 마지막 오류: ${(r.stderr || '').toString().slice(-500)}`);
    return null;
  }
  const m = r.stdout.toString().match(/Bond account address:\s+([1-9A-HJ-NP-Za-km-z]+)/);
  return m?.[1] ?? null;
}

function readOnchainBond(bondAccount) {
  const r = spawnSync('validator-bonds', ['show-bond', bondAccount, '--format', 'json'], {
    timeout: BOND_CLI_TIMEOUT_MS,
  });
  if (timedOut(r)) {
    log('❌ on-chain bond 상태 조회가 시간 안에 끝나지 않았습니다.');
    return null;
  }
  if (r.status !== 0) {
    const output = `${r.stderr || ''}\n${r.stdout || ''}`.trim();
    log(`❌ on-chain bond 상태 조회 실패. validator-bonds 출력: ${output.slice(-800) || `exit ${r.status}`}`);
    return null;
  }
  const m = r.stdout.toString().match(/\{[\s\S]*\}/);
  if (!m) {
    log('❌ on-chain bond 상태 조회 결과에서 JSON을 찾지 못했습니다.');
    return null;
  }
  try {
    const j = JSON.parse(m[0]);
    const bid = parseCpmpeBid(j.account?.costPerMillePerEpoch);
    if (bid == null) {
      log('❌ on-chain bond 상태에서 costPerMillePerEpoch 값을 읽지 못했습니다.');
      return null;
    }
    return {
      bid,
    };
  } catch (e) {
    log(`❌ on-chain bond JSON 파싱 실패: ${e.message}`);
    return null;
  }
}

let validatorBondsForceSupport;
function validatorBondsSupportsForce() {
  if (validatorBondsForceSupport !== undefined) return validatorBondsForceSupport;
  const r = spawnSync('validator-bonds', ['configure-bond', '--help'], {
    timeout: BOND_CLI_TIMEOUT_MS,
    encoding: 'utf8',
  });
  validatorBondsForceSupport = r.status === 0 && /(?:^|\s)--force(?:\s|,|$)/.test(`${r.stdout}\n${r.stderr}`);
  return validatorBondsForceSupport;
}

function buildConfigureBondArgs(bondAccount, cpmpeLamports, opts = {}) {
  const args = ['configure-bond', bondAccount,
    '--authority', opts.authorityFile ?? AUTH_FILE,
    '--cpmpe',     String(cpmpeLamports),
    '-k',          opts.keypairFile ?? KEYPAIR_FILE,
  ];
  if (opts.force) args.push('--force');
  return args;
}

function applyBid(bondAccount, newBid, currentBid) {
  const cpmpeLamports = pmpeToCpmpeLamports(newBid);
  if (cpmpeLamports == null) {
    log(`❌ bid 값이 숫자가 아니라 적용하지 않습니다. 값: ${newBid}`);
    return false;
  }
  const forceDecrease = Number.isFinite(currentBid) && currentBid - newBid > Number.EPSILON;
  const args = buildConfigureBondArgs(bondAccount, cpmpeLamports, {
    force: forceDecrease,
  });
  if (dryRunActive) {
    const forceText = forceDecrease ? ' bid 인하라 --force를 함께 사용합니다.' : '';
    log(`DRY_RUN입니다. 실제 트랜잭션은 보내지 않고 cpmpe=${cpmpeLamports} 적용 명령만 확인했습니다.${forceText}`);
    return true;
  }
  if (forceDecrease && !validatorBondsSupportsForce()) {
    log('❌ 현재 validator-bonds CLI가 --force를 지원하지 않아 bid 인하를 적용할 수 없습니다. npm install -g @marinade.finance/validator-bonds-cli@latest 후 다시 실행하세요.');
    return false;
  }
  if (forceDecrease) {
    log('bid를 낮추는 변경이라 validator-bonds --force를 함께 사용합니다.');
  }
  log(`on-chain bid 변경 트랜잭션을 보냅니다. 새 bid: ${fmtPmpe(newBid)}`);
  const r = spawnSync('validator-bonds', args, { stdio: 'inherit', timeout: BOND_CLI_TIMEOUT_MS });
  if (timedOut(r)) log('❌ bid 변경 트랜잭션이 시간 안에 끝나지 않았습니다.');
  return r.status === 0;
}

// ============================================================
// 메인 1회 실행
// ============================================================
async function runOnce() {
  logVerbose(`검사를 시작합니다. vote account: ${fmtAccount(VOTE_ADDR)}`);

  ensureDsSamReady();

  if (!(await fetchLiveBonds())) {
    await notifyDiscord('❌ `bid-bot`: 최신 bond 입찰 데이터를 받지 못해 이번 회차를 중단했습니다. 오래된 cache로는 적용하지 않습니다.');
    return false;
  }
  if (!(await fetchHeavyIfStale(FORCE_REFRESH))) {
    await notifyDiscord('❌ `bid-bot`: 검증용 보조 데이터 갱신 실패. 오래된 cache로는 계산하지 않고 이번 회차를 중단했습니다.');
    return false;
  }

  if (!runDsSam()) {
    await notifyDiscord('❌ `bid-bot`: Marinade SAM 경매 계산이 실패해 이번 회차를 중단했습니다.');
    return false;
  }

  const status = extractMyStatus();
  if (!status) {
    log('❌ 내 validator가 이번 SAM 경매 결과에 없습니다. vote account와 validator eligibility를 확인해야 합니다.');
    await notifyDiscord(`🚨 \`bid-bot\`: validator ${fmtAccount(VOTE_ADDR)}가 이번 SAM 경매 결과에 없습니다.`);
    return true;
  }

  if (MODE === 'status') {
    console.log(JSON.stringify(status, null, 2));
    return true;
  }
  if (MODE === 'fill-rank') {
    console.log(readFillRankTable(FILL_RANK_LIMIT));
    return true;
  }

  // samEligible 체크는 비활성화되었습니다 (사용자 요청).
  if (!status.samEligible) {
    log('ℹ️ samEligible=false 이지만 체크를 건너뛰고 진행합니다.');
  }

  // bid-too-low 페널티 방지: SAM API(auctions.json)의 내 effParticipatingBidPmpe 최근 N 에폭 min × 1.03을 floor로 사용
  const auctions = readCachedAuctions();
  const recentMinFloor = computeRecentMinFloor(auctions, VOTE_ADDR, status.epoch);
  if (recentMinFloor > 0) {
    logVerbose(`최근 ${RECENT_MIN_LOOKBACK_EPOCHS} 에폭 내 effParticipatingBidPmpe 최소값 × ${RECENT_MIN_MULTIPLIER} = ${fmtPmpe(recentMinFloor)}를 floor로 적용합니다.`);
  }

  let target = computeTargetBid(status.effPart, { recentMinFloor });
  if (!isTargetInSanityRange(target)) {
    log(`⚠️ 계산된 목표 bid ${fmtPmpe(target)}가 안전 범위(${fmtPmpe(MIN_SANITY_BID)}~${fmtPmpe(MAX_SANITY_BID)}) 밖이라 변경하지 않습니다.`);
    return true;
  }

  const bondAccount = resolveBondAccount();
  if (!bondAccount) {
    log('❌ bond account를 찾지 못해 on-chain 상태를 확인할 수 없습니다.');
    await notifyDiscord('❌ `bid-bot`: bond account 조회에 실패해 이번 회차를 중단했습니다.');
    return true;
  }
  logVerbose(`bond account를 확인했습니다. account: ${fmtAccount(bondAccount)}`);

  const onchain = readOnchainBond(bondAccount);
  if (!onchain) {
    log('❌ on-chain bond 상태를 읽지 못해 bid를 변경하지 않습니다.');
    await notifyDiscord('❌ `bid-bot`: on-chain bond 상태 조회에 실패해 이번 회차를 중단했습니다.');
    return true;
  }
  logVerbose(`현재 on-chain bid는 ${fmtPmpe(onchain.bid)}입니다.`);

  if (!shouldChangeBid(onchain.bid, target)) {
    if (showCalculationTable) {
      log(formatBidCalculationTable(status, onchain.bid, target, {
        includeMinChange: dryRunActive,
        recentMinFloor,
      }));
      log(`변경 기준(${fmtPmpe(MIN_BID_CHANGE_PMPE)})보다 차이가 작아서 이번에는 bid를 유지합니다.`);
    } else {
      logVerbose(`변경 기준(${fmtPmpe(MIN_BID_CHANGE_PMPE)})보다 차이가 작아서 이번에는 bid를 유지합니다.`);
    }
    if (status.bidTooLowPenalty > 0) {
      log(`⚠️ bid-too-low 페널티가 발생 중입니다. 현재 페널티: ${fmtPenalty(status.bidTooLowPenalty)}`);
      await notifyDiscord(`⚠️ \`bid-bot\`: bid-too-low 페널티가 발생 중입니다. 현재 페널티: ${fmtPenalty(status.bidTooLowPenalty)}. 수동 점검이 필요합니다.`);
    }
    return true;
  }

  const dropCap = capSingleDrop(onchain.bid, target, status.effPart);
  if (dropCap.capped) {
    log(`⚠️ 목표 bid까지 한 번에 내리기에는 폭이 큽니다. 이번 회차에서는 ${fmtPmpe(onchain.bid)}에서 ${fmtPmpe(dropCap.target)}까지만 낮춥니다.`);
    target = dropCap.target;
    if (dropCap.blocked) {
      log('❌ 인하폭 제한을 적용해도 참여 bid보다 낮아져서 변경하지 않습니다.');
      await notifyDiscord(`⚠️ \`bid-bot\`: 큰 폭 인하가 필요하지만 안전 기준에 걸려 자동 변경을 멈췄습니다. 현재 ${fmtPmpe(onchain.bid)}, 목표 ${fmtPmpe(target)}.`);
      return true;
    }
  }

  if (showCalculationTable) {
    log(formatBidCalculationTable(status, onchain.bid, target, {
      includeMinChange: dryRunActive,
      recentMinFloor,
      title: MODE === 'loop' ? '계산 결과' : undefined,
    }));
  } else {
    log(formatBidCalculationTable(status, onchain.bid, target, {
      recentMinFloor,
      title: 'bid 변경 계산',
    }));
  }
  log(`bid 변경이 필요합니다. ${fmtPmpe(onchain.bid)}에서 ${fmtPmpe(target)}로 조정합니다.`);
  if (applyBid(bondAccount, target, onchain.bid)) {
    if (dryRunActive) return true;
    await notifyDiscord(`✅ \`bid-bot\`: on-chain bid를 ${fmtPmpe(onchain.bid)}에서 ${fmtPmpe(target)}로 변경했습니다. epoch ${status.epoch}, 참여 bid ${fmtPmpe(status.effPart)}.`);
    writeFileSync(STATE_FILE, JSON.stringify({
      last_bid: target, last_change_at: new Date().toISOString(), epoch: status.epoch,
    }, null, 2));
  } else {
    await notifyDiscord('❌ `bid-bot`: on-chain bid 변경에 실패했습니다.');
  }
  return true;
}

export {
  buildConfigureBondArgs,
  calculateEpochTiming,
  capSingleDrop,
  chooseLoopDelayMs,
  computeFillRankRowsFromResults,
  computeRecentMinFloor,
  computeTargetBid,
  extractMyEffBidsFromAuctions,
  extractMyStatusFromResults,
  findValidatorNameByVoteAccount,
  formatDiscordCodeBlockMessages,
  formatDiscordContent,
  formatBidCalculationTable,
  formatFillRankTable,
  fmtDuration,
  isTargetInSanityRange,
  parseCpmpeBid,
  patchDsSamSdkForPrereleaseVersions,
  pmpeToCpmpeLamports,
  refreshHeavyFiles,
  hasFillRankTableChanged,
  resolveMode,
  shouldChangeBid,
  shouldCheckScheduledFillRankReport,
};

// ============================================================
// CLI
// ============================================================
async function checkPrereqs() {
  for (const cmd of ['curl', 'git', 'node', 'validator-bonds']) {
    if (!which(cmd)) die(`${cmd} 필요. 시스템에 설치 후 재시도`);
  }
  if (!VOTE_ADDR) die(`voteAccount 미설정. ${CONFIG_HELP}`);
  if (MODE === 'status' || MODE === 'fill-rank') return;

  if (!BOND_ADDR && (!KEYPAIR_FILE || !existsSync(KEYPAIR_FILE))) {
    die(`bondAccount 미설정. keypair 없이 dry-run하려면 validator.bondAccount를 입력하세요. ${CONFIG_HELP}`);
  }

  if (!dryRunActive) {
    if (!AUTH_FILE) die(`authFile 미설정. validator.authFile을 입력하세요. ${CONFIG_HELP}`);
    if (!KEYPAIR_FILE) die(`keypairFile 미설정. validator.keypairFile을 입력하세요. ${CONFIG_HELP}`);
    if (!existsSync(AUTH_FILE)) die(`authority file 없음: ${AUTH_FILE}`);
    if (!existsSync(KEYPAIR_FILE)) die(`keypair file 없음: ${KEYPAIR_FILE}`);
  }
}

async function main() {
  if (MODE === 'setup') {
    await initDiscordValidatorLabel();
    ensurePnpm();
    ensureDsSamReady();
    log('setup이 끝났습니다. 이제 --dry-run으로 실제 계산 흐름을 확인할 수 있습니다.');
    return;
  }
  await checkPrereqs();
  await initDiscordValidatorLabel();
  if (MODE === 'loop') {
    log(`상시 실행 모드로 시작합니다. 기본 확인 주기는 ${fmtDuration(LOOP_INTERVAL / 1000)}입니다.`);
    if (EPOCH_AWARE_LOOP) {
      log(`epoch-aware loop가 켜져 있습니다. Solana epoch 종료가 ${fmtDuration(EPOCH_FAST_THRESHOLD_SECONDS)} 이내로 다가오면 최대 ${fmtDuration(EPOCH_FAST_INTERVAL / 1000)}마다 확인합니다.`);
    }
    if (loopFillRankReports) {
      log(`fill-rank Discord 알림이 켜져 있습니다. 첫 회차 계산 후 1회 전송하고, 이후 ${fmtDuration(FILL_RANK_DISCORD_CHECK_INTERVAL_MS / 1000)}마다 표 변경 여부를 확인합니다.`);
      if (!DISCORD_WEBHOOK) {
        log('⚠️ discordWebhook이 비어 있어 fill-rank 표를 Discord로 보낼 수 없습니다.');
      }
    }
    let firstLoopRun = true;
    let lastFillRankCheckAt = null;
    let lastFillRankTable = null;
    while (true) {
      if (firstLoopRun) {
        log('첫 회차 확인을 바로 시작합니다. 매 회차 계산표를 표시합니다.');
      }
      let freshResults = false;
      try { freshResults = await runOnce(); } catch (e) { log(`예상하지 못한 오류가 발생했습니다. 다음 회차에서 다시 시도합니다. ${e.stack || e.message}`); }
      const now = Date.now();
      if (loopFillRankReports && freshResults && shouldCheckScheduledFillRankReport(now, lastFillRankCheckAt)) {
        try {
          const table = readFillRankTable(FILL_RANK_LIMIT);
          const changed = hasFillRankTableChanged(table, lastFillRankTable);
          lastFillRankCheckAt = now;
          if (changed) {
            const reason = lastFillRankTable == null ? '시작 알림' : '변경 감지';
            lastFillRankTable = table;
            if (DISCORD_WEBHOOK) {
              await notifyFillRankReportToDiscord(reason, table);
              log(`fill-rank 표 변경을 감지해 Discord로 보냈습니다. 다음 변경 확인은 ${fmtDuration(FILL_RANK_DISCORD_CHECK_INTERVAL_MS / 1000)} 후입니다.`);
            }
          }
        } catch (e) {
          log(`fill-rank Discord 알림 생성에 실패했습니다. 이유: ${e.stack || e.message}`);
        }
      }
      const delayMs = await nextLoopDelayMs();
      const loopDelayMs = loopFillRankReports ? Math.min(delayMs, FILL_RANK_DISCORD_CHECK_INTERVAL_MS) : delayMs;
      if (firstLoopRun) {
        log(`첫 회차 확인이 끝났습니다. 다음 확인은 ${fmtDuration(loopDelayMs / 1000)} 후입니다.`);
        firstLoopRun = false;
      }
      await new Promise(r => setTimeout(r, loopDelayMs));
    }
  } else {
    try { await runOnce(); } catch (e) { log(`예상하지 못한 오류가 발생해 종료합니다. ${e.stack || e.message}`); process.exit(1); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
