# bid-bot

Marinade SAM 자동 bid 관리 봇. 로컬에서 ds-sam SDK를 직접 실행해 실시간 auction 상태를 계산하고, 페널티/winning/cutoff을 모두 고려한 최적 bid을 on-chain에 자동 적용합니다.

## 핵심 기능

- **로컬 ds-sam 실행**: 다른 validator의 mid-epoch bid 변동 즉시 감지 (scoring API보다 빠름)
- **3중 floor**: penalty 회피 + winning 유지 + 안전 버퍼
- **자동 설치**: ds-sam, pnpm, 의존성 모두 자동
- **PM2 통합**: 상시 실행 + epoch 임박 시 빠른 체크
- **bond account 자동 resolve**: vote account에서 bond account를 derive하거나 설정값 사용
- **Discord webhook**: 변경 시 알림
- **DRY_RUN 모드**: 실전 적용 전 안전 검증

## 전제 조건

시스템에 아래 도구 설치되어 있어야 합니다 (자동 설치 안 됨):
- `node` >= 18 (native fetch 필요)
- `git`
- `curl`
- `validator-bonds` CLI 2.4.6 이상 (`npm install -g @marinade.finance/validator-bonds-cli@latest`)
- Marinade config account keypair (`validator.authFile`, `validator.keypairFile`에 지정)

`pnpm`은 자동으로 설치 시도합니다 (corepack / npm / standalone installer 순).

## 설치

```bash
git clone https://github.com/1XP-AI/bid-bot.git
cd bid-bot
npm install        # (의존성 없음, package.json 메타데이터만)

# validator-bonds CLI 설치. bid 인하 적용에는 --force 지원 버전이 필요함.
npm install -g @marinade.finance/validator-bonds-cli@latest
validator-bonds --version
validator-bonds configure-bond --help | grep -- --force

# 로컬 설정 생성. bid-bot.json은 git에 올리지 않음
cp bid-bot.example.json bid-bot.json

# marinade config keypair를 설정 파일의 기본 경로로 복사
mkdir -p keys
cp /path/to/your/marinade-config-keypair.json ./keys/keypair.json

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

실제 변경 없이 현재 상태와 판단 결과만 출력:
```
[2026-05-07 19:30:00 KST] 계산 결과
Item            Value
--------------  --------------------------
Epoch           968
Eligible        Yes
Winning PMPE    0.3479 PMPE
My Total PMPE   0.3494 PMPE
Winning Margin  0.0014 PMPE
EffPart         0.0461 PMPE
Current Bid     0.0475 PMPE
Target Bid      0.0472 PMPE
Bid Change      0.0475 PMPE -> 0.0472 PMPE
Delta           0.0003 PMPE
Min Change      0.0005 PMPE
Current CPMPE   47500000
Target CPMPE    47200000
Penalty         없음
SAM Target      96,820.57 SOL
[2026-05-07 19:30:00 KST] 변경 기준(0.0005 PMPE)보다 차이가 작아서 이번에는 bid를 유지합니다.
```

### 3. 현재 상태 조회

```bash
node bid-bot.js --status
```

내 validator의 모든 메트릭 JSON으로 출력.

### 4. 테스트

```bash
npm test
```

테스트는 네트워크와 on-chain 적용 없이 중요한 계산값만 확인합니다.
- 목표 bid 계산: safety ratio, winning buffer, permitted deviation 중 가장 높은 값 선택
- cpmpe 변환: PMPE bid를 `validator-bonds --cpmpe` lamports 값으로 변환
- on-chain bid 파싱: `costPerMillePerEpoch` 값이 비어 있거나 깨졌을 때 중단
- 변경 기준: 작은 차이는 tx를 보내지 않음
- 큰 폭 인하 제한: 한 번에 너무 많이 낮추지 않음
- epoch-aware loop: epoch 종료 임박 시 5분 주기로 전환

### 5. PM2로 자동화

```bash
mkdir -p logs
pm2 delete bid-bot 2>/dev/null
pm2 start bid-bot.config.cjs
pm2 logs bid-bot
pm2 save  # 재부팅 후 자동 시작
```

기본: `--loop` 모드로 PM2가 항상 살려두고, 스크립트가 내부 timer로 반복 체크. 평소에는 `runtime.loopInterval`초마다 확인하고, `runtime.epochAware.enabled`가 켜져 있으면 Solana epoch 종료가 가까울 때 더 짧은 주기로 확인합니다.

실전 반복 실행에서는 로그를 조용하게 유지합니다. 정상적으로 계산했지만 bid 변경이 필요 없으면 매 회차 진행 로그를 남기지 않고, 실패/경고/실제 bid 변경처럼 확인이 필요한 이벤트만 기록합니다. 상세 계산표가 필요하면 `--dry-run`으로 확인하세요.

실제 bid 변경이 필요한 회차에는 설정 고정값은 빼고, 계산에서 나온 값과 실제 변경될 값만 표로 남깁니다.

```text
[2026-05-07 19:30:00 KST] bid 변경 계산
Item            Value
--------------  --------------------------
Epoch           968
Eligible        Yes
Winning PMPE    0.3479 PMPE
My Total PMPE   0.3494 PMPE
Winning Margin  0.0014 PMPE
EffPart         0.0461 PMPE
Current Bid     0.0475 PMPE
Target Bid      0.0484 PMPE
Bid Change      0.0475 PMPE -> 0.0484 PMPE
Delta           0.0009 PMPE
Current CPMPE   47500000
Target CPMPE    48400000
Penalty         없음
SAM Target      96,820.57 SOL
[2026-05-07 19:30:00 KST] bid 변경이 필요합니다. 0.0475 PMPE에서 0.0484 PMPE로 조정합니다.
[2026-05-07 19:30:00 KST] on-chain bid 변경 트랜잭션을 보냅니다. 새 bid: 0.0484 PMPE
```

### 6. 무한 루프 모드 (PM2 안 쓸 때)

```bash
node bid-bot.js --loop
```

평소에는 `runtime.loopInterval` 초마다 반복합니다. `runtime.epochAware.enabled`가 켜져 있으면 epoch 종료 임박 구간에서 `runtime.epochAware.fastLoopIntervalSeconds`를 사용합니다.

`--loop --dry-run`으로 실행하면 매 회차 상세 계산표를 출력합니다. 운영용 loop에서는 dry-run을 끄는 것을 권장합니다.

## 설정 관리

`bid-bot.json`은 validator마다 다른 로컬 설정 파일이라 git에 올리지 않습니다. repo에는 `bid-bot.example.json`만 추적하고, 각 운영자는 처음 설치할 때 아래처럼 복사해서 사용합니다.

```bash
cp bid-bot.example.json bid-bot.json
nano bid-bot.json
```

다른 경로의 설정을 쓰려면 `BID_BOT_CONFIG`로 지정할 수 있습니다.

```bash
BID_BOT_CONFIG=/path/to/my-bid-bot.json node bid-bot.js --dry-run
```

## 설정 값 (로컬 bid-bot.json)

처음에는 `validator.voteAccount`, `validator.authFile`, `validator.keypairFile`, `runtime.dryRun`만 확인하면 됩니다. 나머지는 기본값으로 시작해도 됩니다.

```jsonc
{
  "validator": {
    // 내 validator의 vote account. 필수.
    "voteAccount": "당신의 vote account",

    // bond account를 알고 있으면 입력. 모르면 빈 값으로 둬도 됨.
    // 비워두면 keypairFile을 사용해서 자동으로 찾음.
    "bondAccount": "",

    // 실제 bid 변경 권한을 가진 authority keypair 파일.
    // 보통 keypairFile과 같은 파일을 넣음.
    "authFile": "./keys/keypair.json",

    // validator-bonds CLI가 트랜잭션을 만들 때 사용할 keypair 파일.
    // dry-run만 할 때는 bondAccount를 직접 넣으면 없어도 됨.
    "keypairFile": "./keys/keypair.json"
  },
  "bidStrategy": {
    // 필요한 bid보다 몇 % 더 여유 있게 올릴지.
    // 1.025 = 계산값보다 2.5% 높게 설정.
    "safetyRatio": 1.025,

    // winning 기준보다 최소 얼마 더 높게 둘지.
    // 값이 너무 작으면 작은 시장 변화에도 밀릴 수 있음.
    "winBufferPmpe": 0.0005,

    // 페널티가 나지 않는 선에서 허용할 여유.
    // 0.01 = 1%. 보통 기본값 유지.
    "permittedDev": 0.01,

    // 현재 bid와 목표 bid 차이가 이 값보다 작으면 변경하지 않음.
    // 너무 작게 잡으면 불필요한 tx가 자주 나감.
    "minBidChangePmpe": 0.0005,

    // 목표 bid가 이 값보다 낮게 계산되면 이상값으로 보고 중단.
    "minSanityBid": 0.005,

    // 목표 bid가 이 값보다 높게 계산되면 이상값으로 보고 중단.
    "maxSanityBid": 0.20,

    // bid를 낮출 때 한 번에 내릴 수 있는 최대 폭.
    // 급격한 인하로 auction에서 밀리는 상황을 막기 위한 안전장치.
    "maxSingleDrop": 0.02
  },
  "logging": {
    // Discord 알림을 받을 webhook URL. 알림이 필요 없으면 빈 값.
    "discordWebhook": "https://discord.com/api/webhooks/..."
  },
  "runtime": {
    // true면 실제 on-chain 변경 없이 로그만 확인.
    // 처음 며칠은 true로 두고 검증한 뒤 false로 바꾸는 것을 권장.
    "dryRun": true,

    // --loop 또는 PM2 실행 시 몇 초마다 한 번씩 확인할지.
    // epoch 종료가 아직 멀 때 사용하는 기본 주기.
    "loopInterval": 3600,

    "epochAware": {
      // true면 Solana epoch 남은 시간을 보고 loop 주기를 자동 조정.
      // 기본값 true. RPC 조회 실패 시에는 loopInterval을 그대로 사용.
      "enabled": true,

      // epoch 종료가 몇 초 이하로 남았을 때 빠른 체크 모드로 들어갈지.
      // 3600 = 1시간 이하로 남으면 빠르게 확인.
      "thresholdSeconds": 3600,

      // 빠른 체크 모드에서 몇 초마다 확인할지.
      // 300 = 5분.
      "fastLoopIntervalSeconds": 300,

      // epoch 남은 시간을 계산할 때 사용할 Solana RPC.
      "solanaRpcUrl": "https://api.mainnet-beta.solana.com",

      // Solana RPC가 이 시간 안에 응답하지 않으면 기본 주기로 fallback.
      // 밀리초 단위. 10000 = 10초.
      "rpcTimeoutMs": 10000
    },

    // Marinade SAM 계산이 이 시간 안에 끝나지 않으면 중단.
    // 밀리초 단위. 300000 = 5분.
    "dsSamTimeoutMs": 300000,

    // validator-bonds CLI 호출이 이 시간 안에 끝나지 않으면 중단.
    // 밀리초 단위. 60000 = 1분.
    "bondCliTimeoutMs": 60000,

    // ds-sam clone/install/build 같은 setup 명령이 이 시간 안에 끝나지 않으면 중단.
    // 밀리초 단위. 900000 = 15분.
    "setupCommandTimeoutMs": 900000
  }
}
```

`bondAccount`를 비워두면 `validator-bonds bond-address <voteAccount>`로 자동 derive합니다. keypair 없이 `--dry-run`을 돌릴 계획이면 `bondAccount`를 명시해두세요.

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
[pm2 --loop / 직접 --loop]
        ↓
1. ds-sam 환경 체크 → 없으면 자동 설치
2. bonds.json fetch (live, 매번; 실패 시 stale cache 적용 방지를 위해 중단)
3. 나머지 입력 fetch (24h 캐시)
4. ds-sam 로컬 실행 (5~10초)
5. results.json에서 내 validator 추출
6. target bid 계산
7. bond account resolve 후 on-chain 현재값과 비교
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
npm install -g @marinade.finance/validator-bonds-cli@latest
validator-bonds --version
validator-bonds configure-bond --help | grep -- --force
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
- vote account가 Marinade validator 목록에 있는지 먼저 확인
- uptime, commission, blacklist, client version 조건 확인
- PSR 대시보드에서 validator 직접 확인

**"samEligible=false가 나오는데 입찰 대상이 맞음"**
- Firedancer rc 버전처럼 `0.909.0-rc...` 형태의 prerelease client version은 원본 ds-sam semver 체크에서 제외될 수 있습니다.
- bid-bot은 setup/run 시 ds-sam SDK를 자동 패치해서 prerelease 버전도 허용합니다.
- 이미 실행 중인 프로세스가 예전 로그(`현재 validator가 SAM 입찰 대상이 아닙니다`)를 계속 찍으면 최신 코드를 pull한 뒤 PM2/loop를 재시작하세요.

## 안전장치

1. **3중 floor**: penalty/winning/safety 동시 만족
2. **MIN_SANITY_BID, MAX_SANITY_BID**: 비정상 값 차단
3. **MAX_SINGLE_DROP**: 큰 폭 인하 방지 (단계적)
4. **stale cache 차단**: live/heavy 데이터 갱신 실패 시 오래된 입력으로 적용하지 않음
5. **DRY_RUN 모드**: 며칠 시뮬레이션 후 실전
6. **MIN_BID_CHANGE_PMPE**: 미세 변동 무시 (불필요한 tx 방지)

## 라이선스

MIT
