/* 组卡器 + 装备安装 交互验证 */
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
const PORT = 10070 + Math.floor(Math.random() * 20);
const profile = mkdtempSync(join(tmpdir(), "gtcg-deck-"));
const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,900",
  pathToFileURL(join(ROOT, "index.html")).href
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}, t = 30000) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("超时 " + m)); } }, t); }); };
const ev = async (b, t) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${b}})()`, awaitPromise: true, returnByValue: true }, t);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]); return r.result.value; };
const shot = async n => { const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(HERE, n), Buffer.from(s.data, "base64")); };

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
    await ev(`window.__errs=[]; window.addEventListener("error",e=>window.__errs.push(String(e.message)));
              window.__logs=[]; const _ce=console.error.bind(console);
              console.error=function(){ window.__logs.push([...arguments].map(a=>String(a&&a.stack||a)).join(" ")); _ce.apply(console,arguments); };
              return true;`);

    console.log("\n===== A. 组卡器（卡牌中心 → 我的卡组）=====");
    await ev(`location.hash="cards"; return true;`); await sleep(500);
    console.log("  卡牌中心激活:", await ev(`return document.getElementById("page-cards").classList.contains("active")`));
    // 切到「我的卡组」标签
    await ev(`const t=[...document.querySelectorAll("#cards-tabs .tab")].find(x=>x.dataset.tab==="deck"); if(t) t.click(); return true;`);
    await sleep(500);
    console.log("  卡组页可见:", await ev(`return document.getElementById("tab-deck").style.display !== "none"`));
    console.log("  卡组槽渲染:", await ev(`return document.querySelectorAll("#deck-slots .deck-slot").length`));
    console.log("  卡池渲染:", await ev(`return document.querySelectorAll("#deck-pool .dp-tile").length`));
    console.log("  当前卡组条目:", await ev(`return document.querySelectorAll("#deck-list .dl-item").length`));
    console.log("  费用曲线:", await ev(`return document.querySelectorAll("#deck-curve .dc-bar").length`));
    console.log("  卡组计数:", await ev(`return (document.getElementById("deck-count")||{}).textContent`));
    console.log("  卡池筛选行:", await ev(`return document.querySelectorAll("#deck-pool-filters .dpf-row").length`));
    await shot("deck-1-builder.png");

    console.log("\n  -- 点卡池加一张 --");
    const before = await ev(`return window.GTCG_DECKS.size(window.GTCG_DECKS._data().active)`);
    await ev(`const t=document.querySelector("#deck-pool .dp-tile"); if(t) t.click(); return true;`);
    await sleep(400);
    const after = await ev(`return window.GTCG_DECKS.size(window.GTCG_DECKS._data().active)`);
    console.log(`  张数 ${before} → ${after}`);

    console.log("\n  -- 点卡组条目移除一张 --");
    await ev(`const t=document.querySelector("#deck-list .dl-item"); if(t) t.click(); return true;`);
    await sleep(400);
    console.log("  张数 →", await ev(`return window.GTCG_DECKS.size(window.GTCG_DECKS._data().active)`));

    console.log("\n  -- 卡池搜索 --");
    await ev(`const s=document.getElementById("deck-pool-search"); s.value="守护"; s.dispatchEvent(new Event("input",{bubbles:true})); return true;`);
    await sleep(300);
    console.log("  搜索后卡池:", await ev(`return document.querySelectorAll("#deck-pool .dp-tile").length`));
    await ev(`const s=document.getElementById("deck-pool-search"); s.value=""; s.dispatchEvent(new Event("input",{bubbles:true})); return true;`);
    await sleep(200);

    console.log("\n  -- 卡组切换（A/B）--");
    await ev(`const t=[...document.querySelectorAll("#deck-slots .deck-slot")][1]; if(t) t.click(); return true;`);
    await sleep(400);
    console.log("  当前编辑:", await ev(`return window.GTCG_DECKS._data().active`));
    console.log("  卡组名:", await ev(`return (document.getElementById("deck-cur-name")||{}).textContent`));

    console.log("\n===== B. 对战卡组选择器（试玩页抽屉里）=====");
    await ev(`location.hash="play"; return true;`); await sleep(400);
    await ev(`if(!document.getElementById("page-play").classList.contains("active")){const a=document.querySelector('.nav-links a[data-page="play"]');if(a)a.click();} return true;`);
    await sleep(400);
    await ev(`const b=document.getElementById("g-panel-btn"); if(b) b.click(); return true;`);
    await sleep(400);
    console.log("  抽屉打开:", await ev(`return document.getElementById("g-drawer").classList.contains("open")`));
    console.log("  选择器按钮:", await ev(`return document.querySelectorAll("#deck-picker-row .dpk-btn").length`));
    console.log("  选择器说明:", await ev(`return (document.getElementById("deck-picker-note")||{}).textContent`));
    await shot("deck-2-picker.png");

    console.log("\n===== C. 装备安装（拖装备到角色）=====");
    await ev(`const b=document.getElementById("g-drawer-close"); if(b) b.click(); return true;`);
    await sleep(300);
    const equipRes = await ev(`
      window.GTCG_AUTO = (t,o)=>{const d=o.find(x=>x.value===null);return d?null:(o[0]?o[0].value:null);};
      const D = window.GTCG_DEBUG;
      D.newGame(); await D.startBattle("p");
      const S = D.S;
      const c = id => CARDS.find(x=>x.id===id);
      const mk = (id,uid)=>({uid,card:c(id),tapped:false,playedTurn:-1,bonus:0,tmpBuff:0,dmgTaken:0,
        battleBuff:0,raidTurn:null,grantedGuard:false,cannotAttack:false,refreshedNoAttack:false,
        resonanceTurn:null,silenceEquip:false,equipCard:null});
      S.p.field = [mk("card09","eqk")];                  // 蠢脸骑士（可装单手剑）
      S.p.energy = ["card12","card12","card12","card12"].map(id=>({card:c(id),tapped:false}));
      S.p.hand = [c("card14")];                          // 新手剑 2费虚
      S.phase = "main"; S.active = S.p;
      D.render();
      await new Promise(r=>setTimeout(r,150));
      const cardEl = document.querySelector("#g-hand .g-handcard");
      const unitEl = document.querySelector('[data-uid="eqk"]');
      if (!cardEl || !unitEl) return "缺 DOM";
      const dt = new DataTransfer();
      const fire = (el,type,x,y) => el.dispatchEvent(new DragEvent(type,{
        bubbles:true, cancelable:true, composed:true, dataTransfer:dt, clientX:x, clientY:y }));
      const cr = cardEl.getBoundingClientRect();
      fire(cardEl,"dragstart",cr.left+cr.width/2,cr.top+cr.height/2);
      const ur = unitEl.getBoundingClientRect();
      fire(unitEl,"dragover",ur.left+ur.width/2,ur.top+ur.height/2);
      fire(unitEl,"drop",ur.left+ur.width/2,ur.top+ur.height/2);
      fire(cardEl,"dragend",cr.left,cr.top);
      await new Promise(r=>setTimeout(r,600));
      const u = S.p.field.find(x=>x.uid==="eqk");
      return JSON.stringify({
        装备: u && u.equipCard ? u.equipCard.name : "无",
        战力: D.core.effPower(u),
        手牌: S.p.hand.length,
        场数: S.p.field.length,
        徽章: document.querySelector('[data-uid="eqk"] .bd-equip') ? "有" : "无"
      });
    `, 30000);
    console.log("  拖装备结果:", equipRes);
    await shot("deck-3-equip.png");

    console.log("\n  -- 专属武器装错角色应被拒 --");
    console.log(" ", await ev(`
      const D=window.GTCG_DEBUG,S=D.S;
      const c = id => CARDS.find(x=>x.id===id);
      const mk=(id,uid)=>({uid,card:c(id),tapped:false,playedTurn:-1,bonus:0,tmpBuff:0,dmgTaken:0,
        battleBuff:0,raidTurn:null,grantedGuard:false,cannotAttack:false,refreshedNoAttack:false,
        resonanceTurn:null,silenceEquip:false,equipCard:null});
      S.p.field = [mk("card04","wrong")];                // 勇士挑战者（不能装剑）
      S.p.hand = [c("card13")];                          // 利贝拉（蠢脸骑士专属）
      S.phase="main"; S.active=S.p; D.render();
      await new Promise(r=>setTimeout(r,150));
      const cardEl=document.querySelector("#g-hand .g-handcard");
      const unitEl=document.querySelector('[data-uid="wrong"]');
      const dt=new DataTransfer();
      const fire=(el,t,x,y)=>el.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,composed:true,dataTransfer:dt,clientX:x,clientY:y}));
      const cr=cardEl.getBoundingClientRect();
      fire(cardEl,"dragstart",cr.left+cr.width/2,cr.top+cr.height/2);
      const ur=unitEl.getBoundingClientRect();
      fire(unitEl,"dragover",ur.left+ur.width/2,ur.top+ur.height/2);
      fire(unitEl,"drop",ur.left+ur.width/2,ur.top+ur.height/2);
      await new Promise(r=>setTimeout(r,400));
      const u=S.p.field[0];
      return "装备=" + (u.equipCard?u.equipCard.name:"无（正确拒绝）") + " 手牌=" + S.p.hand.length;
    `));

    console.log("\n页面错误:", await ev(`return JSON.stringify(window.__errs)`));
    console.log("console.error:", await ev(`return JSON.stringify(window.__logs)`));
    const errs = JSON.parse(await ev(`return JSON.stringify(window.__errs)`));
    const logs = JSON.parse(await ev(`return JSON.stringify(window.__logs)`));
    if (errs.length || logs.length) failed = true;
  } catch (e) {
    console.error("测试失败:", e.message);
    failed = true;
  } finally {
    try { ws && ws.close(); } catch {}
    browser.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exitCode = failed ? 1 : 0;
  }
})();
