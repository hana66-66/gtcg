/* 多回合完整对局压测：专抓「守护后 AI 卡住」这类只在多回合后暴露的问题。
 * 每局都让 AI 与「自动玩家」互打，检测：卡死 / busy 不复位 / 阶段停住 / 弹窗残留。
 * 用法：node tests/soak.mjs [局数]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find(p => existsSync(p));
const GAMES = Number(process.argv[2] || 12);
const PORT = 9980 + Math.floor(Math.random() * 15);
const profile = mkdtempSync(join(tmpdir(), "gtcg-soak-"));
const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,900",
  pathToFileURL(join(ROOT, "index.html")).href
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}, t = 300000) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("超时 " + m)); } }, t); }); };
const ev = async (b, t) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${b}})()`, awaitPromise: true, returnByValue: true }, t);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]); return r.result.value; };

(async () => {
  let failed = false;
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = l.find(x => x.type === "page" && x.url.includes("index.html")); if (t) break; } catch {} await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 80; i++) { const s = await ev(`return JSON.stringify({d:typeof window.GTCG_DEBUG,S:!!(window.GTCG_DEBUG&&window.GTCG_DEBUG.S)})`);
      const o = JSON.parse(s); if (o.d === "object" && o.S) break; await sleep(250); }
    await ev(`location.hash="play"; return true;`); await sleep(400);
    await ev(`if(!document.getElementById("page-play").classList.contains("active")){const a=document.querySelector('.nav-links a[data-page="play"]');if(a)a.click();} return true;`);
    await sleep(400);

    // 异常收集 + 自动应答（开局弹窗、守护选择等）
    await ev(`
      window.__errs = [];
      window.addEventListener("error", e => window.__errs.push(String(e.message)));
      window.addEventListener("unhandledrejection", e => window.__errs.push("REJ:" + String((e.reason && e.reason.message) || e.reason)));
      window.GTCG_FAST = true;
      return true;
    `);

    console.log(`\n=== 多回合对局压测（${GAMES} 局，自动玩家 vs AI）===\n`);
    const summary = await ev(`
      const D = window.GTCG_DEBUG;
      const auto = () => {
        window.GTCG_AUTO = (title, options) => {
          // 守护询问：优先挑能打赢的那个，制造真实的守护拦截
          if (/用谁守护/.test(title)) {
            const best = options.filter(o => o.value && o.value.card).sort((a,b) => (b.value.card.power||0) - (a.value.card.power||0))[0];
            if (best) return best.value;
          }
          if (/响应/.test(title)) return false;
          const decline = options.find(o => o.value === null);
          if (decline) return null;
          return options[0] ? options[0].value : null;
        };
      };
      const mk = (id, uid, tp) => ({ uid, card: CARDS.find(c=>c.id===id), tapped:!!tp, playedTurn:-1,
        bonus:0, tmpBuff:0, dmgTaken:0, battleBuff:0, raidTurn:null, grantedGuard:false,
        cannotAttack:false, refreshedNoAttack:false, resonanceTurn:null, silenceEquip:false, equipCard:null });

      const log = [];
      let stuck = 0, guardHits = 0, maxTurns = 0;

      // 玩家回合：能打的都打；被 AI 攻击时的守护由 auto() 的「用谁守护」分支承担
      async function playerTurn() {
        const S = D.S;
        let g = 0;
        S.phase = "main";
        while (g++ < 30 && !S.over) {
          const i = S.p.hand.findIndex(c => D.core.canPay(S.p, c));
          if (i < 0) break;
          const n = S.p.hand.length;
          await D.play(i);
          if (S.p.hand.length === n) break;
        }
        S.phase = "battle";
        for (const u of [...S.p.field]) {
          if (S.over) return;
          if (!D.core.canAttack(u)) continue;
          const ts = D.core.attackableTargets(u, S.a);
          await D.core.declareAttack(S.p, S.a, u, ts.length ? ts[0] : "player");
        }
      }

      for (let gi = 0; gi < ${GAMES}; gi++) {
        auto();
        D.newGame();
        await D.startBattle(gi % 2 ? "a" : "p");
        let turns = 0, over = false;
        while (!over && turns < 80) {
          turns++;
          if (D.S.over) { over = true; break; }
          if (D.S.active === D.S.p && !D.isBusy()) {
            await playerTurn();
            if (D.S.over) break;
            await D.endTurn();          // 交给 AI；AI 回合在 endTurn 里同步跑完
          } else {
            await new Promise(r => setTimeout(r, 40));
          }
          // 卡死判定：AI 行动中却长时间 busy
          if (D.isBusy() && D.S.active === D.S.a) { await new Promise(r => setTimeout(r, 200)); }
        }
        // 收尾判定
        const S = D.S;
        const leftoverModal = document.querySelectorAll(".modal-mask.open").length;
        const busyStuck = D.isBusy();
        // 这一局战报里出现过的守护行数
        const guardLines = [...document.querySelectorAll("#g-log .g-log-line")]
                            .filter(l => /守护/.test(l.textContent)).length;
        window.__guardLog = window.__guardLog || [];
        window.__guardLog.push(guardLines);
        if (!over || busyStuck || leftoverModal > 0) stuck++;
        log.push({ g: gi, turns, over, busyStuck, leftoverModal,
                   aiField: S.a.field.length, pField: S.p.field.length,
                   phase: S.phase, active: S.active === S.p ? "你" : "AI" });
        if (busyStuck || leftoverModal) console.log("  ⚠ 第 " + gi + " 局异常: " + JSON.stringify(log[log.length-1]));
      }
      maxTurns = Math.max(...log.map(l => l.turns));
      return JSON.stringify({ stuck, maxTurns, games: ${GAMES}, log: log.slice(0, 12) }, null, 1);
    `, 600000);

    console.log(summary);
    const r = JSON.parse(summary);
    console.log(`\n完成 ${r.games} 局；卡死/异常: ${r.stuck} 局；最长 ${r.maxTurns} 回合`);
    // 逐局统计战报里的守护行，确认「守护」这条路径真的被走过
    const guards = await ev(`
      const D = window.GTCG_DEBUG;
      let total = 0;
      for (const e of window.__guardLog || []) total += e;
      return JSON.stringify({ total });
    `);
    console.log("守护相关战报:", guards);
    console.log("页面错误:", await ev(`return JSON.stringify(window.__errs)`));
    const errs = JSON.parse(await ev(`return JSON.stringify(window.__errs)`));
    if (errs.length) failed = true;
    if (r.stuck > 0) failed = true;
  } catch (e) {
    console.error("压测失败:", e.message);
    failed = true;
  } finally {
    try { ws && ws.close(); } catch {}
    browser.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exitCode = failed ? 1 : 0;
  }
})();
