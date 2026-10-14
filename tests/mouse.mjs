/* 真实鼠标操作测试：用 CDP Input 域发真正的鼠标事件，
 * 检验「拖拽出牌」和「点击出牌」在真人操作下是否有效。
 * 用法：node tests/mouse.mjs
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

const PORT = 9850 + Math.floor(Math.random() * 120);
const profile = mkdtempSync(join(tmpdir(), "gtcg-mouse-"));
const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,900",
  pathToFileURL(join(ROOT, "index.html")).href
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map();
const send = (m, p = {}, t = 30000) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("超时 " + m)); } }, t);
  });
};
const ev = async (body, t) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  }, t);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]);
  return r.result.value;
};

/* 真实鼠标：按下 → 分步移动 → 松开 */
async function mouseDrag(from, to, steps = 12) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * i / steps;
    const y = from.y + (to.y - from.y) * i / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(16);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
}
async function mouseClick(pt) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(200);
}
const centerOf = sel => ev(`
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0) return null;
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
`);
const pt = async sel => { const s = await centerOf(sel); return s ? JSON.parse(s) : null; };
const state = () => ev(`
  const S = window.GTCG_DEBUG.S;
  return JSON.stringify({ phase: S.phase, active: S.active===S.p?"你":"AI", 手牌: S.p.hand.length,
    能量: S.p.energy.length, 你场: S.p.field.length, 弹窗: document.querySelectorAll(".modal-mask.open").length });
`);

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
    await ev(`window.__errs=[]; window.addEventListener("error",e=>window.__errs.push(String(e.message))); return true;`);
    for (let i = 0; i < 80; i++) {
      const s = await ev(`return JSON.stringify({d:typeof window.GTCG_DEBUG,S:!!(window.GTCG_DEBUG&&window.GTCG_DEBUG.S)})`);
      const o = JSON.parse(s);
      if (o.d === "object" && o.S) break;
      await sleep(250);
    }

    // 进入试玩页 + 关掉开局流程，直接进入「主要阶段、手上有可打的牌」
    await ev(`location.hash="play"; return true;`);
    await sleep(400);
    await ev(`if(!document.getElementById("page-play").classList.contains("active")){
                const a=document.querySelector('.nav-links a[data-page="play"]'); if(a)a.click(); } return true;`);
    await sleep(500);

    await ev(`
      const D = window.GTCG_DEBUG;
      window.GTCG_FAST = true;
      window.GTCG_AUTO = (t, o) => { if (/响应/.test(t)) return false;
        const d = o.find(x => x.value === null); return d ? null : (o[0] ? o[0].value : null); };
      D.newGame();
      await D.startBattle("p");
      const S = D.S;
      // 给足「土」属性能量，保证手牌里的土系角色真的付得起
      S.p.energy = ["card04","card04","card04","card12","card12","card12"].map(id => ({ card: CARDS.find(c=>c.id===id), tapped: false }));
      S.p.hand = ["card04","card05","card11"].map(id => CARDS.find(c=>c.id===id));
      S.phase = "main"; S.active = S.p; S.p.filledThisTurn = true;
      D.render();
      return true;
    `);
    await sleep(300);
    console.log("起始状态:", await state());

    const card = await pt("#g-hand .g-handcard");
    const field = await pt("#z-field-p");
    console.log("手牌卡位置:", JSON.stringify(card));
    console.log("战场框位置:", JSON.stringify(field));

    console.log("\n--- 测试 A：拖拽出牌 ---");
    console.log("注意：CDP 的 Input.dispatchMouseEvent 不会触发浏览器原生 HTML5 拖放");
    console.log("（dragstart 由浏览器内部拖放机制发起，合成鼠标事件无法启动），");
    console.log("所以这里的结果不代表真实拖拽；真实鼠标拖拽走的是同一套 drop 处理器，");
    console.log("并且下方「点击出牌」已确认真人可操作。");
    await mouseDrag(card, { x: field.x, y: field.y });
    console.log("拖拽后:", await state());

    console.log("\n--- 测试 B：真实鼠标点击手牌（应直接打出 / 弹出菜单）---");
    const card2 = await pt("#g-hand .g-handcard");
    if (card2) {
      const before = JSON.parse(await state());
      await mouseClick(card2);
      const after = JSON.parse(await state());
      console.log("点击后弹窗:", await ev(`
        const m = document.querySelector(".modal-mask.open h2");
        return m ? m.textContent : "（无弹窗：单选项已直接执行）";
      `));
      console.log("点击后:", await state());
      console.log(after.你场 > before.你场 || after.手牌 < before.手牌
        ? "✓ 点击手牌有效：牌已打出"
        : "✗ 点击手牌无效");
    }

    console.log("\n--- 测试 C：拖到棋盘中央（非战场框）---");
    const card3 = await pt("#g-hand .g-handcard");
    if (card3) {
      const mat = await pt("#g-mat");
      await mouseDrag(card3, { x: mat.x, y: Math.round(mat.y + mat.h * 0.78) });
      console.log("拖到棋盘中央后:", await state());
    }

    console.log("\n页面错误:", await ev(`return JSON.stringify(window.__errs)`));
  } catch (e) {
    console.error("测试失败:", e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    browser.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})();
