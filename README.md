# bid-bot

Marinade SAM 자동 bid 관리 봇. 로컬에서 ds-sam SDK를 직접 실행해 실시간 auction 상태를 계산하고, 페널티/winning/cutoff을 모두 고려한 최적 bid을 on-chain에 자동 적용합니다.

## 핵심 기능

- **로컬 ds-sam 실행**: 다른 validator의 mid-epoch bid 변동 즉시 감지 (scoring API보다 빠름)
- **3중 floor**: penalty 회피 + winning 유지 + 안전 버퍼
- **자동 설치**: ds-sam, pnpm, 의존성 모두 자동
- **PM2 통합**: cron 기반 주기 실행
- **Discord webhook**: 변경 시 알림
- **DRY_RUN 모드**: 실전 적용 전 안전 검증

## 전제 조건

시스템에 아래 도구 설치되어 있어야 합니다 (자동 설치 안 됨):
- `node` >= 18 (native fetch 필요)
- `git`
- `curl`
- `validator-bonds` CLI ([설치 가이드](https://github.com/marinade-finance/validator-bonds))
- `validator-keypair.json` (validator 인증 keypair)

`pnpm`은 자동으로 설치 시도합니다 (corepack / npm / standalone installer 순).

## 설치

```bash
git clone https://github.com/1XP-AI/bid-bot.git
cd bid-bot
npm install        # (의존성 없음, package.json 메타데이터만)

# validator-keypair.json을 이 폴더에 복사
cp /path/to/your/validator-keypair.json ./

# 설정 편집 (voteAccount, Discord webhook 등)
nano bid-bot.json

# 권한 부여
chmod +x bid-bot.js
```

## 사용법

### 1. 첫 실행 — ds-sam 자동 설치

```bash
node bid-bot.js --setup
# 또는
npm run setup
```

5~10분 걸림 (ds-sam clone + pnpm install + build).

### 2. 안전 검증 — DRY_RUN 모드

```bash
node bid-bot.js --dry-run
```

실제 변경 없이 결정 로직만 출력:
```
[2026-05-07 10:30:00 UTC] Epoch 968 | effPart=0.0454 winning=0.34 my=0.345
[2026-05-07 10:30:00 UTC] target=0.0476 delta=0.0013
[2026-05-07 10:30:00 UTC] 🔍 DRY_RUN: validator-bonds configure-bond ... --cpmpe 47600000 ...
```

### 3. 현재 상태 조회

```bash
node bid-bot.js --status
```

내 validator의 모든 메트릭 JSON으로 출력.

### 4. PM2로 자동화

```bash
mkdir -p logs
pm2 delete bid-bot 2>/dev/null
pm2 start bid-bot.config.cjs
pm2 logs bid-bot
pm2 save  # 재부팅 후 자동 시작
```

기본: `--loop` 모드로 PM2가 항상 살려두고, 스크립트가 내부 timer로 매 `LOOP_INTERVAL`초(기본 3600 = 60분)마다 1회 체크. 주기 변경은 `bid-bot.config.cjs`의 `env.LOOP_INTERVAL` 수정.

### 5. 무한 루프 모드 (PM2 안 쓸 때)

```bash
node bid-bot.js --loop
```

`runtime.loopInterval` 초마다 반복.

## 설정 (bid-bot.json)

```json
{
  "validator": {
    "voteAccount": "당신의 vote account",
    "authFile": "",
    "keypairFile": ""
  },
  "bidStrategy": {
    "safetyRatio": 1.05,           // effPart × 1.05 (5% buffer)
    "winBufferPmpe": 0.0005,       // winningTotal 위 추가 buffer
    "permittedDev": 0.01,          // 페널티 허용 편차 (production)
    "minBidChangePmpe": 0.0005,    // 이 이하 변동 무시
    "minSanityBid": 0.005,         // 절대 floor
    "maxSanityBid": 0.20,          // 절대 ceiling
    "maxSingleDrop": 0.02,         // 한 번에 최대 인하폭
    "maxStakeSol": 80000           // max_stake_wanted
  },
  "logging": {
    "discordWebhook": "https://discord.com/api/webhooks/..."
  },
  "runtime": {
    "dryRun": false                // 처음엔 true로 며칠 검증
  }
}
```

## bid 결정 공식

```
target = max(
  effPart × (1 - permittedDev),    // 페널티 0 floor
  effPart + winBufferPmpe,         // winning 유지 floor
  effPart × safetyRatio            // 안전 buffer
)
```

세 floor 중 가장 높은 값. 페널티 0 + winning 유지 + 변동성 대비.

## 동작 흐름

```
[pm2 cron 10분마다]
        ↓
1. ds-sam 환경 체크 → 없으면 자동 설치
2. bonds.json fetch (live, 매번)
3. 나머지 입력 fetch (24h 캐시)
4. ds-sam 로컬 실행 (5~10초)
5. results.json에서 내 validator 추출
6. target bid 계산
7. on-chain 현재값과 비교
8. 차이 의미 있으면 validator-bonds CLI로 적용
9. Discord 알림
```

## 모니터링

```bash
# pm2 로그
pm2 logs bid-bot

# 스크립트 로그
tail -f bid-bot.log

# 마지막 변경
cat bid-bot.state
```

## 비상 정지

```bash
pm2 stop bid-bot         # 일시 정지
pm2 delete bid-bot       # 완전 제거

# 또는 안전 모드 (변경 안 함)
# bid-bot.json에서 "dryRun": true 설정 후
pm2 restart bid-bot
```

## 트러블슈팅

**"validator-bonds CLI 필요"**
```bash
# Rust 설치 후
cargo install validator-bonds-cli
```

**"pnpm 자동 설치 실패"**
```bash
corepack enable
corepack prepare pnpm@latest --activate
```

**"ds-sam build 실패"**
```bash
# 수동 재시도
cd ds-sam
pnpm install --frozen-lockfile
pnpm -r build
```

**"validator가 결과에 없음"**
- samEligible 체크: uptime, commission, blacklist 확인
- PSR 대시보드에서 validator 직접 확인

## 안전장치

1. **3중 floor**: penalty/winning/safety 동시 만족
2. **MIN_SANITY_BID, MAX_SANITY_BID**: 비정상 값 차단
3. **MAX_SINGLE_DROP**: 큰 폭 인하 방지 (단계적)
4. **samEligible 체크**: 자격 미달 시 변경 안 함
5. **DRY_RUN 모드**: 며칠 시뮬레이션 후 실전
6. **MIN_BID_CHANGE_PMPE**: 미세 변동 무시 (불필요한 tx 방지)

## 라이선스

MIT
