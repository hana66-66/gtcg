/* 目视验证：在真实 Edge 里打开 index.html，摆出一个中局场面并截图
 * 用法：node tests/shot.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find(p => existsSync(p));

const PORT = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "gtcg-shot-"));
const url = pathToFileURL(join(ROOT, "index.html")).href;

const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,900",
  url
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}, t = 30000) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("超时 " + method)); } }, t);
  });
};
const ev = async (body, t) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  }, t);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]);
  return r.result.value;
};

(async () => {
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find(t => t.type === "page" && t.url.includes("index.html"));
        if (target) break;
      } catch {}
      await sleep(250);
    }
    if (!target) throw new Error("CDP 未就绪");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    await send("Runtime.enable");
    try {
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1600, height: 900, deviceScaleFactor: 1, mobile: false
      });
    } catch (e) {}

    // 等 game.js 初始化
    for (let i = 0; i < 80; i++) {
      const s = await ev(`return JSON.stringify({d: typeof window.GTCG_DEBUG, S: !!(window.GTCG_DEBUG && window.GTCG_DEBUG.S)})`);
      const o = JSON.parse(s);
      if (o.d === "object" && o.S) break;
      await sleep(250);
    }

    // 关掉可能挡住的开局遮罩，摆一个信息量足够的中局
    // 注意：真实 index.html 没有测试钩子，必须先装 GTCG_AUTO，
    // 否则 startBattle 会停在「掷骰」弹窗上等点击，await 永不返回。
    await ev(`
      window.GTCG_AUTO = (title, options) => {
        if (/响应/.test(title)) return false;
        const decline = options.find(o => o.value === null);
        if (decline) return null;
        return options[0] ? options[0].value : null;
      };
      return true;
    `);
    // 真实 index.html 默认停在首页：必须先切到「线上试玩」，否则 .page 未 active，棋盘量不到尺寸
    await ev(`location.hash = "play"; return true;`);
    await sleep(400);
    await ev(`
      // main.js 靠 hash 路由；若未生效就直接点导航
      if (!document.getElementById("page-play").classList.contains("active")) {
        const a = document.querySelector('.nav-links a[data-page="play"]');
        if (a) a.click();
      }
      return document.getElementById("page-play").classList.contains("active");
    `);
    await sleep(300);

    await ev(`
      const D = window.GTCG_DEBUG;
      window.GTCG_FAST = true;
      D.newGame();
      await D.startBattle("p");
      const S = D.S;
      const mk = (id, uid, tapped, extra) => Object.assign({
        uid, card: CARDS.find(c => c.id === id), tapped: !!tapped, playedTurn: -1,
        bonus: 0, tmpBuff: 0, dmgTaken: 0, battleBuff: 0, raidTurn: null,
        grantedGuard: false, cannotAttack: false, refreshedNoAttack: false,
        resonanceTurn: null, silenceEquip: false, equipCard: null
      }, extra || {});
      // 你的战场：守护大怪 / 共鸣中带武器 / 疲劳 / 被减战力
      S.p.field = [
        mk("card05", "u1"),                                        // 巴尔哈尔 5500 守护
        mk("card09", "u2", false, { equipCard: CARDS.find(c=>c.id==="card14"), bonus: 2500, resonanceTurn: S.turnCount }), // 蠢脸骑士+新手剑
        mk("card06", "u3"),                                        // 玛丽安 突袭
        mk("card12", "u4", true),                                  // 哥布林（疲劳）
        mk("card11", "u5", false, { tmpBuff: -2000, dmgTaken: 500 }) // 被减战力
      ];
      // AI 战场
      S.a.field = [
        mk("card10", "e1"),                                        // 克雷格 守护
        mk("card11", "e2", true),
        mk("card02", "e3")
      ];
      S.p.energy = ["card01","card12","card12","card05","card07"].map(id => ({ card: CARDS.find(c=>c.id===id), tapped:false }));
      S.a.energy = ["card12","card12","card10"].map(id => ({ card: CARDS.find(c=>c.id===id), tapped:false }));
      S.p.hand = ["card03","card17","card22","card16","card08","card19"].map(id => CARDS.find(c=>c.id===id));
      S.p.resonance = 7; S.a.resonance = 4;
      S.p.discard = ["card18","card20"].map(id => CARDS.find(c=>c.id===id));
      S.phase = "battle"; S.active = S.p;
      D.render();
      // 触发几个动效，截到动效中的一帧
      const el = document.querySelector('[data-uid="u3"]');
      if (el) { el.classList.add("justAttack","dr"); }
      const el2 = document.querySelector('[data-uid="u5"]');
      if (el2) { el2.classList.add("justHit"); }
      return true;
    `);

    // 等动效播到一半
    await sleep(180);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const out = join(HERE, "screenshot-battle.png");
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("已保存:", out);

    // 再截一张「主要阶段 + 手牌可打出」的状态
    await ev(`
      const D = window.GTCG_DEBUG, S = D.S;
      S.phase = "main"; S.active = S.p;
      D.render();
      return true;
    `);
    await sleep(250);
    const shot2 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(HERE, "screenshot-main.png"), Buffer.from(shot2.data, "base64"));
    console.log("已保存:", join(HERE, "screenshot-main.png"));

    // 打印关键 DOM 尺寸，确认布局没崩
    const info = await ev(`
      const mat = document.getElementById("g-mat");
      const fp = document.getElementById("z-field-p");
      const u = document.querySelector("#z-field-p .g-unit");
      const r = mat.getBoundingClientRect();
      return JSON.stringify({
        棋盘: Math.round(r.width) + "x" + Math.round(r.height),
        战场宽: Math.round(fp.getBoundingClientRect().width),
        单位宽: u ? Math.round(u.getBoundingClientRect().width) : -1,
        单位数: document.querySelectorAll("#z-field-p .g-unit").length,
        手牌数: document.querySelectorAll("#g-hand .g-handcard").length,
        页面溢出: document.documentElement.scrollHeight - window.innerHeight
      }, null, 1);
    `);
    console.log("\n布局实测:", info);

    // 控制台报错
    const errs = await ev(`return JSON.stringify(window.__gtcgErrs || [])`);
    console.log("页面错误:", errs);
  } catch (e) {
    console.error("截图失败:", e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    browser.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})();
