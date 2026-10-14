/* 精确测量新版对局页各区域与卡片的实际矩形，用于定位重叠 */
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
const PORT = 9650 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "gtcg-m-"));
const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run",
  pathToFileURL(join(ROOT, "index.html")).href
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("to")); } }, 20000); }); };
const ev = async b => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${b}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]); return r.result.value; };

(async () => {
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
    await ev(`window.GTCG_FAST=true; window.GTCG_AUTO=(t,o)=>{if(/响应/.test(t))return false;const d=o.find(x=>x.value===null);return d?null:(o[0]?o[0].value:null);};
      const D=window.GTCG_DEBUG; D.newGame(); await D.startBattle("p");
      const S=D.S; const mk=(id,u)=>({uid:u,card:CARDS.find(c=>c.id===id),tapped:false,playedTurn:-1,bonus:0,tmpBuff:0,dmgTaken:0,battleBuff:0,raidTurn:null,grantedGuard:false,cannotAttack:false,refreshedNoAttack:false,resonanceTurn:null,silenceEquip:false,equipCard:null});
      S.p.field=[mk("card05","a1"),mk("card09","a2"),mk("card06","a3"),mk("card12","a4"),mk("card11","a5")];
      S.a.field=[mk("card10","b1"),mk("card11","b2"),mk("card02","b3")];
      S.p.energy=["card01","card12","card12","card05","card07"].map(id=>({card:CARDS.find(c=>c.id===id),tapped:false}));
      S.a.energy=["card12","card12"].map(id=>({card:CARDS.find(c=>c.id===id),tapped:false}));
      S.phase="battle"; S.active=S.p; D.render(); return true;`);
    await sleep(500);

    console.log(await ev(`
      const R = el => { if (!el) return null; const r = el.getBoundingClientRect();
        return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), l: Math.round(r.left), rr: Math.round(r.right), w: Math.round(r.width) }; };
      const out = {
        varH: getComputedStyle(document.documentElement).getPropertyValue("--unit-h").trim(),
        varW: getComputedStyle(document.documentElement).getPropertyValue("--unit-w").trim(),
        app: R(document.getElementById("g-app")),
        top: R(document.querySelector(".g-top")),
        mat: R(document.getElementById("g-mat")),
        board: R(document.querySelector(".g-board")),
        fieldA: R(document.getElementById("z-field-a")),
        fieldP: R(document.getElementById("z-field-p")),
        energyA: R(document.getElementById("z-energy-a")),
        energyP: R(document.getElementById("z-energy")),
        midline: R(document.querySelector(".g-midline")),
        unitP: R(document.querySelector('[data-uid="a1"]')),
        unitA: R(document.querySelector('[data-uid="b1"]')),
        eCard: R(document.querySelector("#z-energy .g-energy")),
        handbar: R(document.querySelector(".g-handbar")),
        hand: R(document.getElementById("g-hand"))
      };
      // 重叠检测
      const ov = (x, y, nx, ny) => x && y && !(x.b <= y.t || y.b <= x.t) && !(x.rr <= y.l || y.rr <= x.l);
      out.overlaps = {
        "AI场 vs 中线": ov(out.fieldA, out.midline),
        "中线 vs 你场": ov(out.midline, out.fieldP),
        "你场 vs 你费用": ov(out.fieldP, out.energyP),
        "AI费用 vs AI场": ov(out.energyA, out.fieldA),
        "你费用 vs 手牌条": ov(out.energyP, out.handbar),
        "你场卡 vs 你费用": ov(out.unitP, out.energyP),
        "AI场卡 vs 中线": ov(out.unitA, out.midline)
      };
      return JSON.stringify(out, null, 1);
    `));
  } catch (e) { console.error("失败:", e.message); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} browser.kill(); await sleep(200); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
})();
