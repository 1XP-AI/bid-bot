// bid-bot.config.js — pm2 ecosystem
//
// 동작: --loop 모드로 bid-bot.js 실행 → 내부 timer로 반복 체크
// 기본 주기는 bid-bot.json의 runtime.loopInterval을 따르고,
// epoch-aware loop가 켜져 있으면 epoch 종료 임박 시 더 짧은 주기로 체크.
// PM2는 프로세스를 항상 살려둠 (autorestart). 비정상 종료 시 5초 후 재시작.
//
// 사용법:
//   pm2 start bid-bot.config.js
//   pm2 logs bid-bot
//   pm2 save

module.exports = {
  apps: [
    {
      name: 'bid-bot',
      script: './bid-bot.js',
      interpreter: 'node',
      cwd: __dirname,
      args: ['--loop'],                        // 핵심: 스크립트가 내부 timer로 반복
      autorestart: true,                       // 비정상 종료 시 PM2가 재시작
      max_restarts: 10,
      restart_delay: 5000,                     // 5초 후 재시작
      env: {
        PATH: process.env.PATH +
              ':/usr/local/bin' +
              ':/home/' + (process.env.USER || 'mb') + '/.local/share/pnpm' +
              ':/home/' + (process.env.USER || 'mb') + '/.cargo/bin' +
              ':/home/' + (process.env.USER || 'mb') + '/.local/bin' +
              ':/home/' + (process.env.USER || 'mb') + '/.npm-global/bin',

        BID_BOT_CONFIG: './bid-bot.json',

        // 임시 override (디버깅 용도)
        // LOOP_INTERVAL: '3600',
        // DRY_RUN: 'true',
        // SAFETY_RATIO: '1.10',
      },
      out_file: './logs/bid-bot-out.log',
      error_file: './logs/bid-bot-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
