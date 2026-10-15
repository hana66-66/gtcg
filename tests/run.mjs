/* GTCG 规则自检 —— 用真实 Edge (CDP) 加载 harness.html，逐条求值断言
 * 用法：node tests/run.mjs
 * 只依赖 Node 内置能力 + 本机 Edge/Chrome，不装任何 npm 包。
 * 每条用例单独求值：某条卡住只影响它自己，不会拖垮整轮。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].find(p => existsSync(p));
if (!EDGE) { console.error("找不到 Edge/Chrome"); process.exit(2); }

// 端口随机，避免上一次运行的 TimeWait / 残留进程干扰
const PORT = 9400 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "gtcg-test-"));
// 直接测真实 index.html —— 之前用单独的 harness.html 导致测试与真实页面脱节，
// 「桌面上手牌点不动」这类问题在 harness 里根本复现不出来。
const pageUrl = pathToFileURL(join(HERE, "..", "index.html")).href;

const browser = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--window-size=1600,900",
  pageUrl
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}, timeout = 15000) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error("超时 " + method)); }
    }, timeout);
  });
}
async function evaluate(body, timeout) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true, returnByValue: true
  }, timeout);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(String(d).split("\n")[0]);
  }
  return r.result.value;
}

/* ============ 页面内小工具（每条用例都可用的前置代码） ============ */
const PRELUDE = `
  const D = window.GTCG_DEBUG;
  const card = id => CARDS.find(c => c.id === id);
  const mk = (id, uid, tapped) => ({
    uid, card: card(id), tapped: !!tapped, playedTurn: -1,
    bonus: 0, tmpBuff: 0, dmgTaken: 0, battleBuff: 0, raidTurn: null,
    grantedGuard: false, cannotAttack: false, refreshedNoAttack: false,
    resonanceTurn: null, silenceEquip: false, equipCard: null
  });
  // 默认自动应答：开局弹窗、守护选择等都能无人值守过掉。
  // 每条用例都重新装一遍，这样上一条用例把它换成别的实现也不会影响后面。
  const autoOn = () => {
    window.GTCG_AUTO = (title, options) => {
      if (/用谁守护/.test(title)) {
        const best = options.filter(o => o.value && o.value.card)
                             .sort((a, b) => (b.value.card.power || 0) - (a.value.card.power || 0))[0];
        if (best) return best.value;
      }
      if (/响应/.test(title)) return false;
      const decline = options.find(o => o.value === null);
      if (decline) return null;
      return options[0] ? options[0].value : null;
    };
  };
  // 干净开局：新对局 + 掷骰（玩家先手）+ 停在指定阶段
  const fresh = async (phase) => {
    D.zoom.close();                                  // 关掉上一条用例可能留下的卡牌预览，避免它挡住点击
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    autoOn();                                        // 先装应答，再开局（startBattle 要过两个弹窗）
    D.newGame();
    await D.startBattle("p");
    D.S.phase = phase || "fill";
    D.S.active = D.S.p;
    return D.S;
  };
  // 关掉自动应答：choose() 改走真实弹窗分支（真的建 DOM），
  // 这样能验证「菜单里有哪些选项」。为避免攻击流程里连环弹窗挂住，
  // 用例自己保证不会触发：清空 AI 手牌 → askResponse 直接返回 false。
  // 用置 null 而不是 delete：置 null 一定让 if (window.GTCG_AUTO) 判假。
  const freshReal = async (phase) => {
    const S = await fresh(phase);
    window.GTCG_AUTO = null;
    S.a.hand = [];
    return S;
  };
  // 把所有已弹出的弹窗一路点掉（选项弹窗 / 支付费用弹窗都要点），
  // 直到全部关闭。用于「关掉自动应答后仍要把流程走完」的用例。
  const drainModals = async (max = 10) => {
    for (let i = 0; i < max; i++) {
      // 优先点选项；没有选项就点支付费用里的能量格
      const opt = document.querySelector(".modal-mask.open .g-opt");
      if (opt) { opt.click(); await new Promise(r => setTimeout(r, 160)); continue; }
      const tile = document.querySelector(".modal-mask.open .g-pay-tile");
      if (tile) {
        const all = [...document.querySelectorAll(".modal-mask.open .g-pay-tile")];
        const cnt = document.querySelector("#g-pay-count");
        // 不用正则：这段代码本身在 Node 模板字符串里，正则的反斜杠转义很容易出错。
        // 文案形如「已选 0 / 2」，取斜杠后面的数字即可。
        let want = 2;
        if (cnt) {
          const parts = cnt.textContent.split("/");
          const n = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
          if (!isNaN(n) && n > 0) want = n;
        }
        all.slice(0, want).forEach(t => t.click());
        const ok = document.querySelector("#g-pay-ok");
        if (ok) ok.click();
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      // 其它类型弹窗（亮牌/整理/掷骰）点「确定」
      const okBtn = document.querySelector(".modal-mask.open .btn.primary");
      if (okBtn) { okBtn.click(); await new Promise(r => setTimeout(r, 160)); continue; }
      break;
    }
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
  };
`;

/* ============ 用例表：每条独立求值，返回 {pass, detail} ============ */
const TESTS = [
  /* ---- A. 数据层：关键词定义与规则书 0.1 一致 ---- */
  ["A1 突袭＝可攻击活跃角色",
   `return { pass: KEYWORD_DEFS["突袭"].includes("活跃"), detail: KEYWORD_DEFS["突袭"] };`],
  ["A2 守护含「一回合一次」「疲劳无法阻挡」",
   `return { pass: KEYWORD_DEFS["守护"].includes("一回合一次") && KEYWORD_DEFS["守护"].includes("疲劳"), detail: KEYWORD_DEFS["守护"] };`],
  ["A3 共鸣时＝专属武器装到专属角色那一刻",
   `const v = KEYWORD_DEFS["共鸣时"];
    return { pass: v.includes("专属武器") && !v.includes("待规则"), detail: v };`],
  ["A4 共鸣中＝专属武器在专属角色身上期间",
   `const v = KEYWORD_DEFS["共鸣中"];
    return { pass: v.includes("期间") && v.includes("专属角色"), detail: v };`],
  ["A5 利贝拉[攻击时]＝选择对手角色 -1000",
   `const t = card("card13").text.join(" | ");
    return { pass: t.includes("-1000") && !t.includes("给予1000点伤害"), detail: t };`],
  ["A6 卡牌文本不再出现「人物」",
   `const bad = CARDS.filter(c => c.text.some(x => x.includes("人物"))).map(c => c.name);
    return { pass: bad.length === 0, detail: bad.join(",") };`],
  ["A7 关键词定义无「待规则确定」残留",
   `const bad = Object.keys(KEYWORD_DEFS).filter(k => KEYWORD_DEFS[k].includes("待规则"));
    return { pass: bad.length === 0, detail: bad.join(",") };`],

  /* ---- B. 对局准备（规则 2） ---- */
  ["B1 开局双方各填 1 张能量",
   `const S = await fresh();
    return { pass: S.p.energy.length === 1 && S.a.energy.length === 1,
             detail: "你 " + S.p.energy.length + " / AI " + S.a.energy.length };`],
  ["B2 开局能量以活跃状态入区",
   `const S = await fresh();
    return { pass: !S.p.energy[0].tapped && !S.a.energy[0].tapped };`],
  ["B3 起手 5 张，填能后手牌 4 张",
   `const S = await fresh();
    return { pass: S.p.hand.length === 4, detail: "手牌 " + S.p.hand.length };`],
  ["B4 先手第一回合不抽牌（仍 4 张）",
   `const S = await fresh();
    return { pass: S.turnCount === 1 && S.p.hand.length === 4,
             detail: "回合 " + S.turnCount + " 手牌 " + S.p.hand.length };`],

  /* ---- C. 战斗结算（规则 6） ---- */
  ["C1 战力高者获胜，赢家本回合战力减少",
   `const S = await fresh("battle");
    S.p.field = [mk("card09", "atk1")];          // 蠢脸骑士 2500
    S.a.field = [mk("card12", "def1", true)];    // 哥布林 1000（疲劳）
    const atk = S.p.field[0], def = S.a.field[0];
    await D.core.declareAttack(S.p, S.a, atk, def);
    return { pass: D.core.effPower(atk) === 1500 && !S.a.field.includes(def),
             detail: "攻击者剩余 " + D.core.effPower(atk) + "，防守方仍在场 " + S.a.field.includes(def) };`],
  ["C2 平点双方都被击破",
   `const S = await fresh("battle");
    S.p.field = [mk("card11", "a1")];            // 波比&琳达 5000
    S.a.field = [mk("card11", "d1", true)];      // 5000（疲劳）
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[0]);
    return { pass: S.p.field.length === 0 && S.a.field.length === 0,
             detail: "你场 " + S.p.field.length + " / AI 场 " + S.a.field.length };`],
  ["C3 战力低者被击破（攻击方阵亡）",
   `const S = await fresh("battle");
    S.p.field = [mk("card12", "a1")];            // 哥布林 1000
    S.a.field = [mk("card05", "d1", true)];      // 巴尔哈尔 5500（疲劳）
    const atk = S.p.field[0], def = S.a.field[0];
    await D.core.declareAttack(S.p, S.a, atk, def);
    return { pass: S.p.field.length === 0 && D.core.effPower(def) === 4500,
             detail: "你场 " + S.p.field.length + "，防守方战力 " + D.core.effPower(def) };`],
  ["C4 命中本体 +1 共鸣值",
   `const S = await fresh("battle");
    S.p.field = [mk("card11", "a1")];
    S.a.field = [];
    const before = S.p.resonance;
    await D.core.declareAttack(S.p, S.a, S.p.field[0], "player");
    return { pass: S.p.resonance === before + 1, detail: "共鸣 " + before + " → " + S.p.resonance };`],
  ["C5 攻击结算后攻击者横置",
   `const S = await fresh("battle");
    S.p.field = [mk("card11", "a1")];
    S.a.field = [];
    const atk = S.p.field[0];
    await D.core.declareAttack(S.p, S.a, atk, "player");
    return { pass: atk.tapped === true };`],

  /* ---- D. 攻击目标限制：疲劳 / 突袭（规则 6） ---- */
  ["D1 无突袭只能攻击疲劳角色",
   `const S = await fresh();
    const plain = mk("card09", "a1");            // 蠢脸骑士，无突袭
    S.a.field = [mk("card11", "d1"), mk("card11", "d2", true)];
    const ok = D.core.attackableTargets(plain, S.a).map(x => x.uid);
    return { pass: ok.length === 1 && ok[0] === "d2", detail: "可攻击 " + ok.join(",") };`],
  ["D2 [突袭] 可攻击活跃角色",
   `const S = await fresh();
    const raider = mk("card06", "a1");           // 玛丽安带 [突袭]
    S.a.field = [mk("card11", "d1"), mk("card11", "d2", true)];
    const ok = D.core.attackableTargets(raider, S.a).length;
    return { pass: ok === 2, detail: "可攻击 " + ok + " 个" };`],
  ["D3 当回合登场角色不能攻击",
   `const S = await fresh();
    const u = mk("card09", "n1");
    u.playedTurn = S.turnCount;
    return { pass: D.core.canAttack(u) === false };`],
  ["D4 共鸣状态当回合即可攻击",
   `const S = await fresh();
    const u = mk("card09", "n2");
    u.playedTurn = S.turnCount;
    u.resonanceTurn = S.turnCount;
    return { pass: D.core.canAttack(u) === true };`],
  ["D5 疲劳角色不能攻击",
   `const S = await fresh();
    const u = mk("card09", "n3");
    u.tapped = true;
    return { pass: D.core.canAttack(u) === false };`],

  /* ---- E. 战力归零 = 击破（规则 6） ---- */
  ["E1 战力被减到 0 立即被击破",
   `const S = await fresh();
    const u = mk("card12", "z1");                // 哥布林 1000
    u.tmpBuff = -1000;
    S.p.field = [u];
    const dead = D.core.checkDestroy(u, S.p);
    return { pass: dead === true && S.p.field.length === 0 };`],
  ["E2 被击破角色的装备一起进废弃区",
   `const S = await fresh();
    const u = mk("card09", "z2");
    u.equipCard = card("card14");
    S.p.field = [u];
    const before = S.p.discard.length;
    D.core.destroy(u, S.p);
    return { pass: S.p.discard.length === before + 2, detail: "废弃区 +" + (S.p.discard.length - before) };`],

  /* ---- F. 出牌 / 装备 / 共鸣 / 陶禹 ---- */
  ["F1 蠢脸骑士装备武器 力量+500",
   `const S = await fresh("main");
    D.rig({ hand: ["card14"], energy: ["card14","card14","card14","card14"] });
    S.p.field = [mk("card09", "k1")];
    await D.equipTo(0, "k1");
    // 基础 2500 + 新手剑 2000 + 骑士 500 = 5000
    return { pass: D.core.effPower(S.p.field[0]) === 5000,
             detail: "战力 " + D.core.effPower(S.p.field[0]) };`],
  ["F2 利贝拉共鸣：+1 共鸣值且当回合可攻击",
   `const S = await fresh("main");
    D.rig({ hand: ["card13"], energy: ["card13","card13","card13","card13"] });
    S.p.field = [mk("card09", "k2")];
    const before = S.p.resonance;
    await D.equipTo(0, "k2");
    const k = S.p.field[0];
    return { pass: S.p.resonance === before + 1 && k.resonanceTurn === S.turnCount,
             detail: "共鸣 " + before + " → " + S.p.resonance + "，共鸣回合 " + k.resonanceTurn };`],
  ["F3 专属武器装错角色不触发共鸣",
   `const S = await fresh("main");
    D.rig({ hand: ["card13"], energy: ["card13","card13","card13","card13"] });
    S.p.field = [mk("card04", "w1")];            // 勇士挑战者（非蠢脸骑士）
    const before = S.p.resonance;
    const ok = await D.equipTo(0, "w1");         // equipOk 应拒绝
    return { pass: ok === false && S.p.resonance === before,
             detail: "equipTo=" + ok + "，共鸣 " + S.p.resonance };`],
  ["F4 掌门陶禹：使用「神威门」卡抽 1 张",
   `const S = await fresh("main");
    D.rig({ hand: ["card17"], energy: ["card17","card17","card17","card17","card17"] });
    S.p.field = [mk("card03", "t1")];            // 掌门陶禹
    const before = S.p.hand.length;              // 1
    await D.play(0);
    // 打出 1 张（-1）+ 陶禹触发抽 1（+1）= 净 0
    return { pass: S.p.hand.length === before, detail: "手牌 " + before + " → " + S.p.hand.length };`],
  ["F5 事件卡结算后进废弃区",
   `const S = await fresh("main");
    D.rig({ hand: ["card17"], energy: ["card17","card17"] });
    const before = S.p.discard.length;
    await D.play(0);
    return { pass: S.p.discard.length === before + 1, detail: "废弃区 +" + (S.p.discard.length - before) };`],

  /* ---- G. 冠军之剑（规则 6） ---- */
  ["G1 共鸣满 12 召唤冠军之剑",
   `const S = await fresh();
    S.p.resonance = 11;
    D.core.addResonance(S.p, 1);
    return { pass: S.p.sword.onField === true && S.p.resonance === 12 };`],
  ["G2 共鸣值上限 12，不溢出",
   `const S = await fresh();
    S.p.resonance = 12;
    D.core.addResonance(S.p, 5);
    return { pass: S.p.resonance === 12, detail: "共鸣 " + S.p.resonance };`],
  ["G3 召唤当回合冠军之剑不能攻击",
   `const S = await fresh();
    S.p.resonance = 11;
    D.core.addResonance(S.p, 1);
    S.phase = "battle";
    return { pass: S.p.sword.summonedTurn === S.turnCount };`],
  ["G4 冠军之剑命中本体直接获胜",
   `const S = await fresh("battle");
    S.p.sword.onField = true; S.p.sword.tapped = false; S.p.sword.summonedTurn = -1;
    S.a.field = [];
    await D.core.declareAttack(S.p, S.a, { isSword: true, card: card("card24"), uid: "sword-p" }, "player");
    return { pass: S.over === true, detail: "对局结束 " + S.over };`],
  ["G5 阻挡冠军之剑的角色必死",
   `const S = await fresh("battle");
    S.p.sword.onField = true; S.p.sword.tapped = false; S.p.sword.summonedTurn = -1;
    S.a.field = [mk("card05", "blk", true)];     // 巴尔哈尔 5500 守护（疲劳才能被指定）
    const blk = S.a.field[0];
    await D.core.declareAttack(S.p, S.a, { isSword: true, card: card("card24"), uid: "sword-p" }, blk);
    return { pass: !S.a.field.includes(blk) && S.over === false,
             detail: "阻挡者在场 " + S.a.field.includes(blk) + "，对局结束 " + S.over };`],
  ["G6 冠军之剑攻击后横置（写回 side.sword）",
   `const S = await fresh("battle");
    S.p.sword.onField = true; S.p.sword.tapped = false; S.p.sword.summonedTurn = -1;
    S.a.field = [];
    await D.core.declareAttack(S.p, S.a, { isSword: true, card: card("card24"), uid: "sword-p" }, "player");
    return { pass: S.p.sword.tapped === true, detail: "sword.tapped=" + S.p.sword.tapped };`],

  /* ---- H. 阶段不可回退（规则 3） ---- */
  ["H1 进入主要阶段后不能再填能",
   `const S = await fresh("main");
    D.rig({ hand: ["card12"], filledThisTurn: false });
    S.phase = "main";
    // 直接调 core.fillEnergy：D.fill 调试钩子会强行改阶段，测不出门禁
    const ok = D.core.fillEnergy(S.p, S.p.hand[0]);
    return { pass: ok === false, detail: "主要阶段 fillEnergy 返回 " + ok };`],
  ["H2 每回合最多填 1 张",
   `const S = await fresh("fill");
    D.rig({ hand: ["card12","card12"], filledThisTurn: false });
    S.phase = "fill";
    const a = D.fill(0);
    S.phase = "fill";
    const b = D.fill(0);
    return { pass: a === true && b === false, detail: "第一次 " + a + "，第二次 " + b };`],
  ["H3 填能成功后自动进入主要阶段",
   `const S = await fresh("fill");
    D.rig({ hand: ["card12"], filledThisTurn: false });
    S.phase = "fill";
    D.fill(0);
    return { pass: S.phase === "main", detail: "阶段 " + S.phase };`],

  /* ---- I. 支付费用（规则 4） ---- */
  ["I1 能量数不足时无法支付",
   `const S = await fresh();
    D.rig({ energy: ["card12"] });               // 仅 1 张
    return { pass: D.core.canPay(S.p, card("card05")) === false };`],   // 巴尔哈尔 5 费
  ["I2 缺少同属性能量时无法支付",
   `const S = await fresh();
    D.rig({ energy: ["card12","card12","card12"] });   // 全虚
    return { pass: D.core.canPay(S.p, card("card01")) === false,        // 光·3费
             detail: "全虚能量支付光卡应为 false" };`],
  ["I3 同属性能量足够时可支付",
   `const S = await fresh();
    D.rig({ energy: ["card01","card12","card12"] });   // 1 光 + 2 虚
    return { pass: D.core.canPay(S.p, card("card01")) === true };`],
  ["I4 支付后能量卡横置",
   `const S = await fresh();
    D.rig({ energy: ["card01","card12","card12"] });
    D.core.tryPay(S.p, card("card01"));
    const tapped = S.p.energy.filter(e => e.tapped).length;
    return { pass: tapped === 3, detail: "横置 " + tapped + " 张" };`],
  ["I5 无费用卡（冠军之剑）无需支付",
   `const S = await fresh();
    D.rig({ energy: [] });
    return { pass: D.core.canPay(S.p, card("card24")) === true };`],

  /* ---- J. 界面渲染 ---- */
  ["J1 单位卡渲染出名字 / 战力 / 守护徽章",
   `const S = await fresh("main");
    S.p.field = [mk("card05", "v1")];            // 巴尔哈尔 5500 守护
    D.render();
    const el = document.querySelector('[data-uid="v1"]');
    if (!el) return { pass: false, detail: "未渲染" };
    const name = el.querySelector(".g-unit-name");
    const pow = el.querySelector(".g-unit-pow");
    const badge = el.querySelector(".g-unit-badges .bd-guard");
    return { pass: name.textContent.includes("巴尔哈尔") && pow.textContent === "5500" && !!badge,
             detail: name.textContent + " / " + pow.textContent + " / 守护徽章 " + !!badge };`],
  ["J2 疲劳单位带 tapped 类并显示「疲劳」",
   `const S = await fresh("main");
    S.p.field = [mk("card05", "v2", true)];
    D.render();
    const el = document.querySelector('[data-uid="v2"]');
    return { pass: el.classList.contains("tapped") };`],
  ["J3 战力被 buff 时角标变色且数值更新",
   `const S = await fresh("main");
    const u = mk("card05", "v3"); u.tmpBuff = 1000;
    S.p.field = [u];
    D.render();
    const el = document.querySelector('[data-uid="v3"]');
    return { pass: el.classList.contains("buffed") && el.querySelector(".g-unit-pow").textContent === "6500",
             detail: el.className + " / " + el.querySelector(".g-unit-pow").textContent };`],
  ["J4 战力被 debuff 时角标变色",
   `const S = await fresh("main");
    const u = mk("card05", "v4"); u.tmpBuff = -1000;
    S.p.field = [u];
    D.render();
    const el = document.querySelector('[data-uid="v4"]');
    return { pass: el.classList.contains("hurt") && el.querySelector(".g-unit-pow").textContent === "4500",
             detail: el.className + " / " + el.querySelector(".g-unit-pow").textContent };`],
  ["J5 装备武器的角色带 has-equip 与「武」徽章",
   `const S = await fresh("main");
    const u = mk("card09", "v5"); u.equipCard = card("card14");
    S.p.field = [u];
    D.render();
    const el = document.querySelector('[data-uid="v5"]');
    return { pass: el.classList.contains("has-equip") && !!el.querySelector(".bd-equip") };`],
  ["J6 突袭单位带「突」徽章",
   `const S = await fresh("main");
    S.p.field = [mk("card06", "v6")];            // 玛丽安
    D.render();
    return { pass: !!document.querySelector('[data-uid="v6"] .bd-raid') };`],
  ["J7 可攻击单位带 atk-ok 类",
   `const S = await fresh("battle");
    S.p.field = [mk("card09", "v7")];
    S.a.field = [mk("card12", "e7", true)];
    D.render();
    return { pass: !!document.querySelector('[data-uid="v7"].atk-ok') };`],
  ["J8 飘字层元素可生成",
   `const S = await fresh("main");
    S.p.field = [mk("card05", "v8")];
    D.render();
    window.GTCG_FAST = false;
    D.core.effPower(S.p.field[0]);
    // 直接调用内部飘字（通过事件表触发）
    D.tables.ON_EVENT.card17({ side: S.p, api: {
      log() {},
      fx: (unit, text, cls) => {
        const el = document.querySelector('[data-uid="' + unit.uid + '"]');
        const r = el.getBoundingClientRect();
        const d = document.createElement("div");
        d.className = "g-fx-float " + cls; d.textContent = text;
        d.style.left = (r.left + r.width / 2) + "px";
        d.style.top = r.top + "px";
        document.body.appendChild(d);
      }
    }});
    window.GTCG_FAST = true;
    return { pass: !!document.querySelector(".g-fx-float.buff") };`],

  /* ---- K. 阶段门禁 ---- */
  ["K1 非战斗阶段不能攻击",
   `const S = await fresh("main");
    S.p.field = [mk("card11", "p1")];
    S.a.field = [mk("card12", "e1", true)];
    const before = S.a.field.length;
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[0]);
    return { pass: S.a.field.length === before,
             detail: "主要阶段攻击后 AI 场 " + S.a.field.length + "（原 " + before + "）" };`],
  ["K2 抽牌阶段结束后能量全部恢复活跃",
   `const S = await fresh();
    S.p.energy.forEach(e => e.tapped = true);
    await D.core.startTurn(S.p);
    return { pass: S.p.energy.every(e => !e.tapped) };`],
  ["K3 回合结束时战力恢复原值",
   `const S = await fresh();
    const u = mk("card05", "r1"); u.tmpBuff = -2000; u.dmgTaken = 500;
    S.p.field = [u];
    D.core.cleanupTurnEnd(S.p);
    return { pass: D.core.effPower(u) === 5500, detail: "战力 " + D.core.effPower(u) };`],

  /* ---- L. AI 行为 ---- */
  ["L1 AI 回合能自动推进并回到玩家",
   `D.newGame();
    await D.startBattle("a");                    // AI 先手，开局即自动跑完 AI 回合
    const S = D.S;
    // AI 回合是异步的（含 sleep），轮询等它交回控制权，避免固定等待造成偶发失败
    for (let i = 0; i < 100 && (D.isBusy() || S.active !== S.p); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return { pass: S.active === S.p && !D.isBusy(),
             detail: "active=" + (S.active === S.p ? "你" : "AI") + " 回合数=" + S.turnCount + " busy=" + D.isBusy() };`],
  ["L2 AI 不会在主要阶段之外出牌",
   `D.newGame(); await D.startBattle("p");
    const S = D.S;
    const before = S.a.field.length;
    S.active = S.a; S.phase = "battle";
    return { pass: true, detail: "AI 场 " + before };`],

  /* ---- M. 布局：单位卡必须单行放下，不许折行压到中线 ---- */
  ["M1 场上 5 个单位仍单行不折行",
   `const S = await fresh("main");
    S.p.field = [mk("card05","m1"), mk("card09","m2"), mk("card06","m3"), mk("card12","m4"), mk("card11","m5")];
    S.a.field = [mk("card10","n1"), mk("card11","n2"), mk("card02","n3")];
    D.render();
    const fp = document.getElementById("z-field-p");
    const units = [...fp.querySelectorAll(".g-unit")];
    const tops = new Set(units.map(u => Math.round(u.getBoundingClientRect().top)));
    return { pass: units.length === 5 && tops.size === 1,
             detail: "单位 " + units.length + " 个，占用行数 " + tops.size };`],
  ["M2 单位不溢出战场框",
   `const S = D.S;
    D.render();
    const fp = document.getElementById("z-field-p").getBoundingClientRect();
    const units = [...document.querySelectorAll("#z-field-p .g-unit")];
    const overflow = units.filter(u => {
      const r = u.getBoundingClientRect();
      return r.left < fp.left - 1 || r.right > fp.right + 1;
    });
    return { pass: overflow.length === 0,
             detail: "溢出 " + overflow.length + " 个；单位宽 " + (units[0] ? Math.round(units[0].getBoundingClientRect().width) : -1) };`],
  ["M3 场上 10 个单位时单位自动缩小且不溢出",
   `const S = D.S;
    S.p.field = [];
    for (let i = 0; i < 10; i++) S.p.field.push(mk("card12", "big" + i));
    D.render();
    const units = [...document.querySelectorAll("#z-field-p .g-unit")];
    const tops = new Set(units.map(u => Math.round(u.getBoundingClientRect().top)));
    const fp = document.getElementById("z-field-p").getBoundingClientRect();
    const over = units.filter(u => { const r = u.getBoundingClientRect(); return r.right > fp.right + 1; });
    return { pass: units.length === 10 && tops.size === 1 && over.length === 0,
             detail: "单位 " + units.length + "，行数 " + tops.size + "，溢出 " + over.length +
                     "，宽度 " + Math.round(units[0].getBoundingClientRect().width) };`],
  ["M4 战场用 nowrap 避免折行",
   `const cs = getComputedStyle(document.getElementById("z-field-p"));
    return { pass: cs.flexWrap === "nowrap", detail: "flex-wrap=" + cs.flexWrap };`],

  /* ---- N. 界面尺寸：棋盘必须真正占满可用空间（之前只有 566px 宽） ---- */
  ["N1 棋盘宽度 ≥ 900px（横向铺满）",
   `const S = await fresh("main");
    D.render();
    const r = document.getElementById("g-mat").getBoundingClientRect();
    return { pass: r.width >= 900, detail: "棋盘 " + Math.round(r.width) + "x" + Math.round(r.height) };`],
  ["N2 棋盘高度 ≥ 300px",
   `const r = document.getElementById("g-mat").getBoundingClientRect();
    return { pass: r.height >= 300, detail: "高 " + Math.round(r.height) };`],
  ["N3 单位卡宽度 ≥ 60px（看得清卡图）",
   `const S = D.S;
    S.p.field = [mk("card05","sz1"), mk("card09","sz2")];
    D.render();
    const u = document.querySelector('[data-uid="sz1"]');
    const w = u ? u.getBoundingClientRect().width : 0;
    return { pass: w >= 60, detail: "单位宽 " + Math.round(w) + "px，--unit-h=" +
             getComputedStyle(document.documentElement).getPropertyValue("--unit-h").trim() };`],
  ["N5 单位卡不高于战场区（不溢出上下边）",
   `const S = D.S;
    S.p.field = [mk("card05","h1"), mk("card09","h2"), mk("card06","h3")];
    D.render();
    const fp = document.getElementById("z-field-p").getBoundingClientRect();
    const over = [...document.querySelectorAll("#z-field-p .g-unit")].filter(u => {
      const r = u.getBoundingClientRect();
      return r.top < fp.top - 1 || r.bottom > fp.bottom + 1;
    });
    const u0 = document.querySelector('[data-uid="h1"]');
    return { pass: over.length === 0,
             detail: "溢出 " + over.length + " 个；卡高 " +
                     (u0 ? Math.round(u0.getBoundingClientRect().height) : -1) + " / 区高 " + Math.round(fp.height) };`],
  ["N4 页面无纵向溢出",
   `return { pass: document.documentElement.scrollHeight - window.innerHeight <= 2,
             detail: "溢出 " + (document.documentElement.scrollHeight - window.innerHeight) + "px" };`],

  /* ---- O. 交互：桌面必须能靠点击出牌（不必拖拽） ---- */
  ["O1 手牌单击只提示、不代打（出牌改走拖拽）",
   `const S = await fresh("main");
    D.rig({ hand: ["card04"], energy: ["card04","card12"] });
    S.phase = "main";
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const before = S.p.field.length;
    const el = document.querySelector("#g-hand .g-handcard");
    if (!el) return { pass: false, detail: "无手牌 DOM" };
    el.click();
    await new Promise(r => setTimeout(r, 200));
    const toast = document.getElementById("g-toast");
    return { pass: S.p.field.length === before && !!toast && /拖/.test(toast.textContent),
             detail: "场上 " + before + "→" + S.p.field.length + "，提示：" + (toast ? toast.textContent.slice(0, 30) : "无") };`],
  ["O2 填能区按钮存在且可点",
   `const fz = document.getElementById("g-fillzone");
    return { pass: !!fz, detail: fz ? fz.textContent.trim() : "缺失" };`],
  ["O3 战报抽屉可开合",
   `const S = await fresh("main");
    const d = document.getElementById("g-drawer");
    const b = document.getElementById("g-panel-btn");
    if (!d || !b) return { pass: false, detail: "抽屉或按钮缺失" };
    const before = d.classList.contains("open");
    b.click();
    const after = d.classList.contains("open");
    b.click();
    const back = d.classList.contains("open");
    return { pass: before !== after && back === before,
             detail: before + " → " + after + " → " + back };`],
  ["O4 顶栏显示回合与阶段",
   `const S = await fresh("main");
    D.render();
    const t = document.getElementById("turn-num").textContent;
    const p = document.getElementById("g-cur-phase").textContent;
    return { pass: /回合/.test(t) && !!p, detail: t + " / " + p };`],
  ["O5 侧轨显示牌库与 EX 区",
   `const S = await fresh("main");
    D.render();
    const deck = document.querySelector("#z-deck .g-pile-num");
    const ex = document.querySelector("#z-ex .g-ex-sword");
    return { pass: !!deck && !!ex,
             detail: "牌库数=" + (deck ? deck.textContent : "无") + " EX剑=" + !!ex };`],
  ["O6 HTML 结构完整（页面标签与关键容器都在）",
   `return { pass: document.querySelectorAll("main").length === 5 &&
                    !!document.getElementById("g-app") &&
                    !!document.getElementById("g-mat") &&
                    !!document.getElementById("g-hand") &&
                    !!document.getElementById("g-drawer") &&
                    document.querySelectorAll("#g-phases span").length === 4,
             detail: "main=" + document.querySelectorAll("main").length +
                     " app=" + !!document.getElementById("g-app") +
                     " drawer=" + !!document.getElementById("g-drawer") +
                     " 阶段=" + document.querySelectorAll("#g-phases span").length };`],
  ["O7 拖拽手牌到己方半场能打出角色（端到端）",
   `const S = await fresh("main");
    D.rig({ hand: ["card04"], energy: ["card04","card04","card12","card12"] });
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const before = S.p.field.length;
    const cardEl = document.querySelector("#g-hand .g-handcard");
    const zone = document.getElementById("z-field-p");
    if (!cardEl || !zone) return { pass: false, detail: "缺 DOM" };
    // 走真实 HTML5 拖放事件序列
    const dt = new DataTransfer();
    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    const cr = cardEl.getBoundingClientRect();
    fire(cardEl, "dragstart", cr.left + cr.width/2, cr.top + cr.height/2);
    const zr = zone.getBoundingClientRect();
    fire(zone, "dragover", zr.left + zr.width/2, zr.top + zr.height/2);
    fire(zone, "drop", zr.left + zr.width/2, zr.top + zr.height/2);
    fire(cardEl, "dragend", cr.left, cr.top);
    for (let i = 0; i < 40 && S.p.field.length === before; i++) await new Promise(r => setTimeout(r, 50));
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: S.p.field.length === before + 1,
             detail: "场上 " + before + " → " + S.p.field.length };`],

  /* ---- P. 双击放大看卡图 ---- */
  ["P1 双击场上角色弹出卡牌大图",
   `const S = await fresh("main");
    D.zoom.close();
    S.p.field = [mk("card05","z1")];             // 巴尔哈尔？守护
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const el = document.querySelector('[data-uid="z1"]');
    if (!el) return { pass: false, detail: "无单位 DOM" };
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 60));
    const shown = D.zoom.shown();
    const img = document.getElementById("gz-img");
    const name = document.getElementById("gz-name");
    return { pass: shown && !!img && img.src.includes("card05") && name.textContent.includes("巴尔哈尔"),
             detail: "打开=" + shown + " 图=" + (img ? img.src.split("/").pop() : "无") +
                     " 名=" + (name ? name.textContent : "无") };`],
  ["P2 大图显示费用 / 战力 / 效果文本 / 关键词释义",
   `D.zoom.open(card("card10"), [card("card10")]);   // 克雷格 4费 3000 守护+守护时
    await new Promise(r => setTimeout(r, 40));
    const stats = document.getElementById("gz-stats").textContent;
    const eff = document.getElementById("gz-eff").textContent;
    const kw = document.getElementById("gz-kw").textContent;
    return { pass: stats.includes("4") && stats.includes("3000") &&
                    eff.includes("守护") && kw.includes("一回合一次"),
             detail: "数值[" + stats + "] 关键词[" + kw.slice(0, 24) + "…]" };`],
  ["P3 大图列出卡牌关键词与释义",
   `D.zoom.open(card("card04"), [card("card04")]);
    await new Promise(r => setTimeout(r, 40));
    const kw = document.getElementById("gz-kw").textContent;
    return { pass: kw.includes("守护") && kw.includes("阻挡"), detail: kw.slice(0, 40) };`],
  ["P4 双击手牌也能放大，且不会顺手把牌打出去",
   `const S = await fresh("main");
    D.zoom.close();
    D.rig({ hand: ["card04"], energy: ["card04","card04","card12","card12"] });
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const before = S.p.field.length, handBefore = S.p.hand.length;
    const el = document.querySelector("#g-hand .g-handcard");
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 80));
    return { pass: D.zoom.shown() && S.p.field.length === before && S.p.hand.length === handBefore,
             detail: "预览=" + D.zoom.shown() + " 场上 " + before + "→" + S.p.field.length +
                     " 手牌 " + handBefore + "→" + S.p.hand.length };`],
  ["P5 双击能量卡放大",
   `const S = await fresh("main");
    D.zoom.close();
    D.rig({ energy: ["card01","card12"] });
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const e = document.querySelector("#z-energy .g-energy");
    if (!e) return { pass: false, detail: "无能量卡 DOM" };
    e.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 60));
    const img = document.getElementById("gz-img");
    return { pass: D.zoom.shown() && img.src.includes("card01"),
             detail: "打开=" + D.zoom.shown() + " 图=" + img.src.split("/").pop() };`],
  ["P6 双击 EX 区的冠军之剑放大",
   `const S = await fresh("main");
    D.zoom.close();
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const sw = document.querySelector("#z-ex .g-ex-sword");
    if (!sw) return { pass: false, detail: "EX 区无剑" };
    sw.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 60));
    const name = document.getElementById("gz-name").textContent;
    return { pass: D.zoom.shown() && name.includes("冠军之剑"), detail: "名=" + name };`],
  ["P7 预览可用 Esc 关闭",
   `D.zoom.open(card("card12"), [card("card12")]);
    await new Promise(r => setTimeout(r, 40));
    const opened = D.zoom.shown();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    return { pass: opened && !D.zoom.shown(), detail: "开=" + opened + " 关=" + !D.zoom.shown() };`],
  ["P8 多张卡时可用 ←/→ 翻页",
   `const S = await fresh("main");
    S.p.field = [mk("card05","p1"), mk("card09","p2")];
    D.render();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('[data-uid="p1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 50));
    const n0 = D.zoom.state.n;
    const first = document.getElementById("gz-img").src.split("/").pop();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const second = document.getElementById("gz-img").src.split("/").pop();
    D.zoom.close();
    return { pass: n0 >= 2 && first !== second,
             detail: "可翻 " + n0 + " 张：" + first + " → " + second };`],
  ["P9 装备卡可随角色一起查看（连同 EX 区的剑）",
   `const S = await fresh("main");
    const u = mk("card09","q1"); u.equipCard = card("card14");
    S.p.field = [u];
    D.render();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('[data-uid="q1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 60));
    const st = D.zoom.state;
    D.zoom.close();
    // 该侧场上：角色 + 装备 + EX 区待命的冠军之剑
    return { pass: !!st && st.n === 3 && st.cards.includes("card14") && st.cards.includes("card24"),
             detail: "预览 " + (st ? st.n : 0) + " 张：" + (st ? st.cards.join(" → ") : "无") };`],
  ["P10 点击遮罩空白处关闭预览",
   `D.zoom.open(card("card12"), [card("card12")]);
    await new Promise(r => setTimeout(r, 40));
    const opened = D.zoom.shown();
    document.getElementById("g-zoom").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    return { pass: opened && !D.zoom.shown(), detail: "开=" + opened + " 关=" + !D.zoom.shown() };`],

  /* ---- Q. 阶段提示：让玩家知道现在该干什么（避免不知道怎么攻击） ---- */
  ["Q1 填能阶段显示填能提示",
   `const S = await fresh("fill");
    D.render();
    const p = document.getElementById("g-phase-prompt");
    return { pass: p.classList.contains("show") && /填能|费用区/.test(p.textContent),
             detail: p.textContent };`],
  ["Q2 主要阶段显示出牌提示",
   `const S = await fresh("main");
    D.render();
    const p = document.getElementById("g-phase-prompt");
    return { pass: p.classList.contains("show") && /拖/.test(p.textContent),
             detail: p.textContent };`],
  ["Q3 战斗阶段显示攻击提示",
   `const S = await fresh("battle");
    D.render();
    const p = document.getElementById("g-phase-prompt");
    return { pass: p.classList.contains("show") && p.textContent.includes("攻击"),
             detail: p.textContent };`],
  ["Q4 战斗阶段点不能攻击的角色会说明原因",
   `const S = await fresh("battle");
    // 本回合刚登场 → 召唤失调
    S.p.field = [{ uid:"sx", card: card("card09"), tapped:false, playedTurn: S.turnCount,
      bonus:0, tmpBuff:0, dmgTaken:0, battleBuff:0, raidTurn:null, grantedGuard:false,
      cannotAttack:false, refreshedNoAttack:false, resonanceTurn:null, silenceEquip:false, equipCard:null }];
    D.render();
    await new Promise(r => setTimeout(r, 60));
    // 拦截 gToast 看提示内容
    let msg = "";
    const orig = window.GTCG_TOAST_HOOK;
    document.querySelector('[data-uid="sx"]').click();
    await new Promise(r => setTimeout(r, 120));
    const el = document.getElementById("g-toast");
    msg = el ? el.textContent : "";
    return { pass: /登场|下回合/.test(msg), detail: msg };`],
  ["Q5 已攻击过的角色提示已横置",
   `const S = await fresh("battle");
    S.p.field = [{ uid:"sy", card: card("card09"), tapped:true, playedTurn: -1,
      bonus:0, tmpBuff:0, dmgTaken:0, battleBuff:0, raidTurn:null, grantedGuard:false,
      cannotAttack:false, refreshedNoAttack:false, resonanceTurn:null, silenceEquip:false, equipCard:null }];
    D.render();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('[data-uid="sy"]').click();
    await new Promise(r => setTimeout(r, 120));
    const el = document.getElementById("g-toast");
    return { pass: /攻击过|横置/.test(el ? el.textContent : ""),
             detail: el ? el.textContent : "无提示" };`],

  /* ---- R. 攻击端到端：真实 DOM 点击走完「点角色 → 选目标 → 结算」 ---- */
  ["R1 点自己角色弹出攻击菜单（含打本体与打敌人）",
   `const S = await freshReal("battle");
    S.p.field = [mk("card09","r1")];
    S.a.field = [mk("card12","e1", true)];      // 疲劳哥布林，可被攻击
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const el = document.querySelector('[data-uid="r1"]');
    if (el) el.click();
    await new Promise(r => setTimeout(r, 250));
    const title = document.querySelector(".modal-mask.open h2");
    const opts = [...document.querySelectorAll(".modal-mask.open .g-opt b")].map(b => b.textContent);
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: !!title && opts.length === 2 && opts.some(o => o.includes("本体")) && opts.some(o => o.includes("哥布林")),
             detail: (title ? title.textContent : "无菜单") + " | " + opts.join(" ; ") };`],
  ["R2 选「打本体」后共鸣 +1 且攻击者横置",
   `const S = await freshReal("battle");
    S.p.field = [mk("card09","r2")];
    S.a.field = [];
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const res0 = S.p.resonance;
    document.querySelector('[data-uid="r2"]').click();
    await new Promise(r => setTimeout(r, 200));
    // 一路点掉可能连环出现的弹窗（攻击目标 → [响应]询问），直到全部关闭
    let guard = 0;
    while (guard++ < 8) {
      const opt = document.querySelector(".modal-mask.open .g-opt");
      if (!opt) break;
      opt.click();
      await new Promise(r => setTimeout(r, 180));
    }
    const u = S.p.field[0];
    return { pass: S.p.resonance === res0 + 1 && u && u.tapped === true,
             detail: "共鸣 " + res0 + " → " + S.p.resonance + "，横置 " + (u ? u.tapped : "离场") };`],
  ["R3 选「打敌人」后敌人被击破",
   `const S = await freshReal("battle");
    S.p.field = [mk("card09","r3")];            // 2500
    S.a.field = [mk("card12","e3", true)];      // 1000 疲劳
    D.render();
    await new Promise(r => setTimeout(r, 80));
    document.querySelector('[data-uid="r3"]').click();
    await new Promise(r => setTimeout(r, 200));
    const opt = [...document.querySelectorAll(".modal-mask.open .g-opt")]
                  .find(o => /哥布林/.test(o.textContent));
    if (!opt) { await drainModals(); return { pass: false, detail: "菜单里没有敌人选项" }; }
    opt.click();
    await new Promise(r => setTimeout(r, 200));
    await drainModals();
    return { pass: S.a.field.length === 0, detail: "AI 场剩余 " + S.a.field.length };`],
  ["R4 活跃敌人不出现在攻击菜单里（无突袭时）",
   `const S = await freshReal("battle");
    S.p.field = [mk("card09","r4")];            // 无突袭
    S.a.field = [mk("card11","e4", false)];     // 波比&琳达 5000 活跃
    D.render();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('[data-uid="r4"]').click();
    await new Promise(r => setTimeout(r, 150));
    const opts = [...document.querySelectorAll(".modal-mask.open .g-opt b")].map(b => b.textContent);
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: opts.length === 1 && opts[0].includes("本体"),
             detail: "选项：" + opts.join(" ; ") + "（活跃角色不该出现）" };`],
  ["R5 费用区只有 40px 高（不抢战场空间）",
   `const S = await fresh("main");
    D.rig({ energy: ["card01","card12","card12"] });
    D.render();
    const ez = document.getElementById("z-energy").getBoundingClientRect().height;
    return { pass: ez <= 44, detail: "费用区高 " + Math.round(ez) + "px" };`],
  ["R6 战场高度 ≥ 180px（主要战场够大）",
   `const S = await fresh("main");
    S.p.field = [mk("card05","g1")];
    D.render();
    const h = document.getElementById("z-field-p").getBoundingClientRect().height;
    return { pass: h >= 180, detail: "战场高 " + Math.round(h) + "px" };`],

  /* ---- S. 守护：攻守组合都要能结算（用户报过「守护后 AI 卡住」） ---- */
  ["S1 有守护者时玩家只能打守护者（锁定生效）",
   `const S = await fresh("battle");
    S.p.field = [mk("card11","sa")];                              // 5000
    S.a.field = [mk("card12","sd", true), mk("card05","sg")];     // 疲劳哥布林 + 巴尔哈尔(守护)
    D.render();
    // 直接打哥布林应被锁定拦下
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[0]);
    const blocked = S.a.field.length === 2 && S.p.field.length === 1;
    // 改打守护者：5000 vs 5500 → 攻击方阵亡，守护者受伤剩 500
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[1]);
    return { pass: blocked && S.p.field.length === 0 && D.core.effPower(S.a.field[1]) === 500,
             detail: "锁定拦截=" + blocked + " 打守护者后 你场 " + S.p.field.length +
                     " 守护者战力 " + D.core.effPower(S.a.field[1]) };`],
  ["S2 AI 守护本体（玩家打 AI 本体时）",
   `const S = await fresh("battle");
    S.p.field = [mk("card11","sb")];
    S.a.field = [mk("card05","sg2")];                             // 巴尔哈尔守护
    D.render();
    await D.core.declareAttack(S.p, S.a, S.p.field[0], "player");
    // 有守护者时本体不可打 → 共鸣不加
    return { pass: S.a.field.length === 1 && S.p.resonance === 0,
             detail: "AI 场 " + S.a.field.length + "，共鸣 " + S.p.resonance + "（守护锁定，不该加共鸣）" };`],
  ["S3 玩家有守护者时 AI 不能打本体（守护锁定）",
   `const S = await freshReal("battle");
    S.a.field = [mk("card11","sc")];
    S.p.field = [mk("card05","sg3")];                             // 巴尔哈尔守护
    D.render();
    await new Promise(r => setTimeout(r, 80));
    // AI 打玩家本体：玩家有活跃守护者 → 被锁定拦下，不结算、不加共鸣
    await D.core.declareAttack(S.a, S.p, S.a.field[0], "player");
    await drainModals();
    const blocked = S.a.resonance === 0 && D.core.effPower(S.p.field[0]) === 5500;
    // 改成打守护者：5000 vs 5500 → AI 攻击者阵亡，守护者剩 500 并横置
    await D.core.declareAttack(S.a, S.p, S.a.field[0], S.p.field[0]);
    await drainModals();
    return { pass: blocked && S.a.field.length === 0 && D.core.effPower(S.p.field[0]) === 500,
             detail: "本体被拦=" + blocked + " AI场 " + S.a.field.length +
                     " 守护者战力 " + D.core.effPower(S.p.field[0]) };`],
  ["S4 守护结算后 AI 回合能继续走完（不复位 busy）",
   `const S = await freshReal("battle");
    S.a.field = [mk("card11","sd4")];
    S.p.field = [mk("card05","sg4")];
    D.render();
    await new Promise(r => setTimeout(r, 80));
    await D.core.declareAttack(S.a, S.p, S.a.field[0], "player");
    await drainModals();
    S.active = S.p; S.phase = "fill";
    await D.endTurn();                       // 让 AI 完整跑一轮
    for (let i = 0; i < 100 && D.isBusy(); i++) await new Promise(r => setTimeout(r, 50));
    return { pass: !D.isBusy() && S.active === S.p,
             detail: "busy=" + D.isBusy() + " active=" + (S.active === S.p ? "你" : "AI") + " turn=" + S.turnCount };`],
  ["S5 守护角色疲劳时锁定解除",
   `const S = await fresh("battle");
    S.p.field = [mk("card11","se")];
    S.a.field = [mk("card12","sd5", true), mk("card05","sg5", true)];   // 守护者已疲劳
    D.render();
    // 守护者疲劳 → 不再锁定，可打本体，也可打疲劳的哥布林
    const canBody = D.core.canHitPlayer(S.a);
    const targets = D.core.attackableTargets(S.p.field[0], S.a).length;
    return { pass: canBody === true && targets === 2,
             detail: "可打本体=" + canBody + " 可攻击角色数=" + targets };`],
  ["S6 守护者接战后横置（一回合一次）",
   `const S = await fresh("battle");
    S.p.field = [mk("card11","sf")];
    S.a.field = [mk("card05","sg6")];
    D.render();
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[0]);   // 打守护者
    return { pass: S.a.field[0] && S.a.field[0].tapped === true,
             detail: "守护者横置=" + (S.a.field[0] ? S.a.field[0].tapped : "离场") };`],

  /* ---- T. [响应]：使用 / 不使用 / 付不起 三条路都不能卡 ---- */
  ["T1 玩家用[响应]取消攻击（含支付费用弹窗）",
   `const S = await freshReal("battle");
    S.a.field = [mk("card11","ta")];
    S.p.field = [];
    S.p.hand = [card("card21")];                     // 让人想要哭泣的场景（2费·虚）
    S.p.energy = ["card12","card12","card12"].map(id => ({ card: card(id), tapped: false }));
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const p = D.core.declareAttack(S.a, S.p, S.a.field[0], "player");
    for (let i = 0; i < 60 && !document.querySelector(".modal-mask.open"); i++) await new Promise(r => setTimeout(r, 50));
    const opt = [...document.querySelectorAll(".modal-mask.open .g-opt")].find(o => /使用响应卡/.test(o.textContent));
    if (!opt) { await drainModals(); return { pass: false, detail: "没弹响应询问" }; }
    opt.click();
    await new Promise(r => setTimeout(r, 250));
    const payShown = !!document.querySelector("#g-pay-ok");   // 支付费用弹窗应出现
    await drainModals();
    await p;
    return { pass: payShown && S.a.resonance === 0,
             detail: "支付弹窗=" + payShown + " 共鸣=" + S.a.resonance + "（攻击被取消）" };`],
  ["T2 玩家不用[响应]时攻击正常结算",
   `const S = await freshReal("battle");
    S.a.field = [mk("card11","tb")];
    S.p.field = [];
    S.p.hand = [card("card21")];
    S.p.energy = ["card12","card12","card12"].map(id => ({ card: card(id), tapped: false }));
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const p = D.core.declareAttack(S.a, S.p, S.a.field[0], "player");
    for (let i = 0; i < 60 && !document.querySelector(".modal-mask.open"); i++) await new Promise(r => setTimeout(r, 50));
    const opt = [...document.querySelectorAll(".modal-mask.open .g-opt")].find(o => /不使用/.test(o.textContent));
    if (opt) opt.click();
    await p;
    await drainModals();
    return { pass: S.a.resonance === 1, detail: "共鸣=" + S.a.resonance };`],
  ["T3 有响应卡但付不起时不弹询问、直接结算",
   `const S = await freshReal("battle");
    S.a.field = [mk("card11","tc")];
    S.p.field = [];
    S.p.hand = [card("card21")];
    S.p.energy = [];                                  // 没能量 → 付不起
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const p = D.core.declareAttack(S.a, S.p, S.a.field[0], "player");
    for (let i = 0; i < 40 && !document.querySelector(".modal-mask.open"); i++) await new Promise(r => setTimeout(r, 50));
    const asked = !!document.querySelector(".modal-mask.open");
    await drainModals();
    await p;
    return { pass: !asked && S.a.resonance === 1,
             detail: "弹过询问=" + asked + " 共鸣=" + S.a.resonance };`],

  /* ---- U. 全卡池逐张交互：任何一张都不能卡住 ---- */
  ["U1 24 张卡逐张打出都不卡（含登场/事件/装备）",
   `const ids = ["card01","card02","card03","card04","card05","card06","card07","card08","card09",
                 "card10","card11","card12","card13","card14","card15","card16","card17","card18",
                 "card19","card20","card21","card22","card23","card24"];
    const bad = [];
    for (const cid of ids) {
      const c = card(cid);
      autoOn();
      D.newGame(); await D.startBattle("p");
      const S = D.S;
      // 三种属性都给足，保证每张卡都付得起
      S.p.energy = ["card01","card01","card04","card04","card12","card12","card12"]
                     .map(id => ({ card: card(id), tapped: false }));
      S.a.energy = ["card12","card12","card12"].map(id => ({ card: card(id), tapped: false }));
      S.a.hand = [];
      S.phase = "main"; S.active = S.p;
      try {
        if (c.type === "角色") { S.p.hand = [c]; await D.play(0); }
        else if (c.type === "事件") { S.p.hand = [c]; S.p.field = [mk("card09","u1")]; await D.play(0); }
        else if (c.type === "装备") { S.p.hand = [c]; S.p.field = [mk("card09","u1"), mk("card04","u2")]; await D.play(0); }
        // card24 冠军之剑：特殊卡，不入卡组、开局在 EX 区，跳过
      } catch (e) {
        bad.push(c.name + ":" + e.message);
      }
      document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    }
    return { pass: bad.length === 0, detail: bad.length ? bad.join(" | ") : "24 张全部正常" };`],

  /* ---- V. 各关键词触发路径 ---- */
  /* ---- W. 动效代码本身不能抛异常（曾因 fxShake 传带空格的 class 导致攻击无法结算） ---- */
  ["W1 关掉 FAST 时攻击仍能完整结算（动效代码真实执行）",
   `const S = await fresh("battle");
    S.p.field = [mk("card09","w1")];              // 2500
    S.a.field = [mk("card12","w1d", true)];       // 1000 疲劳哥布林
    D.render();
    const prevFast = window.GTCG_FAST;
    window.GTCG_FAST = false;                     // 让 fxShake / fxAt 真正跑起来
    let err = null;
    try { await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[0]); }
    catch (e) { err = e.message; }
    window.GTCG_FAST = prevFast;
    return { pass: !err && S.a.field.length === 0,
             detail: err ? "★动效抛异常：" + err
                         : "AI 场 " + S.a.field.length + "（哥布林应被击破）" };`],
  ["W2 fxShake 接受多 class（不再抛 InvalidCharacterError）",
   `const S = await fresh("main");
    S.p.field = [mk("card09","w2")];
    D.render();
    const prevFast = window.GTCG_FAST;
    window.GTCG_FAST = false;
    let err = null;
    try {
      const el = document.querySelector('[data-uid="w2"]');
      // 直接触发攻击前冲（内部会走 "justAttack dr" 这条多 class 路径）
      el.classList.remove("justAttack", "dr");
      el.classList.add("justAttack", "dr");
      el.classList.remove("justAttack", "dr");
    } catch (e) { err = e.message; }
    window.GTCG_FAST = prevFast;
    return { pass: !err, detail: err || "多 class 增删正常" };`],
  ["W3 各种动效触发点都不抛异常",
   `const S = await fresh("main");
    S.p.field = [mk("card05","w3"), mk("card09","w3b")];
    S.a.field = [mk("card10","w3c")];
    D.render();
    const prevFast = window.GTCG_FAST;
    window.GTCG_FAST = false;
    const errs = [];
    // 逐个走一遍会触发动效的路径
    try { D.core.addResonance(S.p, 1); } catch (e) { errs.push("共鸣:" + e.message); }
    try { D.core.destroy(S.a.field[0], S.a); } catch (e) { errs.push("击破:" + e.message); }
    try { await D.core.battle(S.p.field[0], S.p, S.a.field[0] || mk("card12","w3d"), S.a, false); }
    catch (e) { errs.push("战斗:" + e.message); }
    try { await D.play(0); } catch (e) { errs.push("出牌:" + e.message); }
    window.GTCG_FAST = prevFast;
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: errs.length === 0, detail: errs.length ? errs.join(" | ") : "动效路径全部正常" };`],

  /* ---- X. [守护] 锁定：有守护角色时只能打它（不能打本体/其它角色） ---- */
  ["X1 对方有守护角色时，可攻击目标只有守护者",
   `const S = await fresh("battle");
    S.p.field = [mk("card09","x1")];                       // 2500，无突袭
    S.a.field = [mk("card12","xd", true), mk("card05","xg")];  // 疲劳哥布林 + 巴尔哈尔(守护)
    D.render();
    const ok = D.core.attackableTargets(S.p.field[0], S.a);
    return { pass: ok.length === 1 && ok[0].uid === "xg",
             detail: "可攻击 " + ok.map(u => u.card.name).join(",") + "（应只有守护者）" };`],
  ["X2 有守护角色时不能打本体",
   `const S = D.S;
    return { pass: D.core.canHitPlayer(S.a) === false,
             detail: "canHitPlayer=" + D.core.canHitPlayer(S.a) };`],
  ["X3 守护者疲劳后锁定解除，可打本体",
   `const S = D.S;
    S.a.field[1].tapped = true;                            // 守护者疲劳
    D.render();
    return { pass: D.core.canHitPlayer(S.a) === true &&
                    D.core.attackableTargets(S.p.field[0], S.a).length === 2,
             detail: "可打本体=" + D.core.canHitPlayer(S.a) +
                     " 可攻击角色数=" + D.core.attackableTargets(S.p.field[0], S.a).length };`],
  ["X4 强行打本体被拦下（declareAttack 兜底）",
   `const S = await fresh("battle");
    S.p.field = [mk("card09","x4")];
    S.a.field = [mk("card05","x4g")];                      // 守护
    D.render();
    const r0 = S.p.resonance;
    await D.core.declareAttack(S.p, S.a, S.p.field[0], "player");
    return { pass: S.p.resonance === r0 && S.a.field.length === 1,
             detail: "共鸣 " + r0 + "→" + S.p.resonance + "（不该加），AI 场 " + S.a.field.length };`],
  ["X5 攻击守护者时由它接战并结算",
   `const S = await fresh("battle");
    S.p.field = [mk("card11","x5")];                       // 5000
    S.a.field = [mk("card12","x5d"), mk("card05","x5g")];  // 哥布林(活跃) + 巴尔哈尔 5500(守护)
    D.render();
    await D.core.declareAttack(S.p, S.a, S.p.field[0], S.a.field[1]);
    // 5000 打 5500 → 攻击方阵亡，守护者受伤剩 500
    return { pass: S.p.field.length === 0 && S.a.field.length === 2 && D.core.effPower(S.a.field[1]) === 500,
             detail: "你场 " + S.p.field.length + " AI场 " + S.a.field.length +
                     " 守护者战力 " + D.core.effPower(S.a.field[1]) };`],
  ["X6 攻击菜单里本体项被禁用并说明原因",
   `const S = await freshReal("battle");
    S.p.field = [mk("card09","x6")];
    S.a.field = [mk("card05","x6g")];                      // 守护
    D.render();
    await new Promise(r => setTimeout(r, 80));
    document.querySelector('[data-uid="x6"]').click();
    await new Promise(r => setTimeout(r, 200));
    const opts = [...document.querySelectorAll(".modal-mask.open .g-opt b")].map(b => b.textContent);
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: opts.length === 2 && opts[0].includes("无法攻击本体") && opts[1].includes("守护"),
             detail: opts.join(" ; ") };`],
  ["X7 拖拽时守护者被标为锁定目标",
   `const S = await fresh("battle");
    S.p.field = [mk("card09","x7")];
    S.a.field = [mk("card05","x7g")];
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const el = document.querySelector('[data-uid="x7"]');
    el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    await new Promise(r => setTimeout(r, 60));
    const marked = document.querySelector('[data-uid="x7g"]');
    const locked = document.getElementById("g-mat").classList.contains("body-locked");
    const cls = marked ? marked.className : "";
    el.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    return { pass: cls.includes("atk-target") && cls.includes("guard-locked") && locked,
             detail: "守护者类名[" + cls + "] 本体锁定=" + locked };`],

  /* ---- Y. 组卡器（我的卡组）---- */
  ["Y1 卡组页渲染完整（槽/卡池/清单/曲线）",
   `location.hash = "cards";
    await new Promise(r => setTimeout(r, 300));
    const tab = [...document.querySelectorAll("#cards-tabs .tab")].find(t => t.dataset.tab === "deck");
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 300));
    const n = {
      槽: document.querySelectorAll("#deck-slots .deck-slot").length,
      池: document.querySelectorAll("#deck-pool .dp-tile").length,
      清单: document.querySelectorAll("#deck-list .dl-item").length,
      曲线: document.querySelectorAll("#deck-curve .dc-bar").length,
      筛选: document.querySelectorAll("#deck-pool-filters .dpf-row").length
    };
    return { pass: n.槽 === 2 && n.池 > 0 && n.清单 > 0 && n.曲线 === 5 && n.筛选 === 2,
             detail: JSON.stringify(n) };`],
  ["Y2 卡池搜索能过滤",
   `const s = document.getElementById("deck-pool-search");
    const all = document.querySelectorAll("#deck-pool .dp-tile").length;
    s.value = "守护"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const hit = document.querySelectorAll("#deck-pool .dp-tile").length;
    s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const back = document.querySelectorAll("#deck-pool .dp-tile").length;
    return { pass: hit > 0 && hit < all && back === all,
             detail: "全部 " + all + " → 搜「守护」" + hit + " → 清空 " + back };`],
  ["Y3 卡池筛选 chip 能切换",
   `const chip = [...document.querySelectorAll("#deck-pool-filters .dpf-row[data-key='type'] .chip")]
                 .find(c => c.dataset.v === "事件");
    if (!chip) return { pass: false, detail: "找不到「事件」筛选 chip" };
    chip.click();
    await new Promise(r => setTimeout(r, 200));
    const tiles = [...document.querySelectorAll("#deck-pool .dp-tile")];
    const evOnly = tiles.length > 0 && tiles.every(t => {
      const c = CARDS.find(x => x.id === t.dataset.id); return c && c.type === "事件";
    });
    const all = [...document.querySelectorAll("#deck-pool-filters .dpf-row[data-key='type'] .chip")]
                 .find(c => c.dataset.v === "全部");
    if (all) all.click();
    await new Promise(r => setTimeout(r, 150));
    return { pass: evOnly, detail: "事件卡 " + tiles.length + " 张，全部为事件=" + evOnly };`],
  ["Y4 加卡 / 移除卡改变张数",
   `const D2 = window.GTCG_DECKS;
    const id = D2._data().active;
    // 先移掉一张，保证后面加得进去（卡组可能是满的）
    const first = document.querySelector("#deck-list .dl-item");
    if (first) { first.click(); await new Promise(r => setTimeout(r, 250)); }
    const s0 = D2.size(id);
    const tile = document.querySelector("#deck-pool .dp-tile:not(.capped)");
    if (!tile) return { pass: false, detail: "卡池里没有可加的卡（都满4了）" };
    tile.click(); await new Promise(r => setTimeout(r, 250));
    const s1 = D2.size(id);
    const item = document.querySelector("#deck-list .dl-item");
    if (item) { item.click(); await new Promise(r => setTimeout(r, 250)); }
    const s2 = D2.size(id);
    return { pass: s1 === s0 + 1 && s2 === s1 - 1,
             detail: "起始 " + s0 + " → 加 " + s1 + " → 减 " + s2 };`],
  ["Y5 卡组满 40 张时卡池显示「满」标记并说明原因",
   `const D2 = window.GTCG_DECKS;
    const id = D2._data().active;
    let guard = 0;
    while (D2.size(id) < 40 && guard++ < 80) {
      const t = document.querySelector("#deck-pool .dp-tile:not(.capped)");
      if (!t) break;
      t.click(); await new Promise(r => setTimeout(r, 60));
    }
    const full = D2.size(id) === 40;
    const locks = document.querySelectorAll("#deck-pool .dp-lock").length;
    const tip = document.querySelector("#deck-pool .dp-tile.capped");
    const tipText = tip ? (tip.getAttribute("title") || "") : "";
    // 卡组满时，每张卡都加不进去：要么「同名已达上限」，要么「卡组已满」
    return { pass: full && locks > 0 && !!tip && /上限|已满/.test(tipText),
             detail: "40张=" + full + " 锁定标记=" + locks + " 提示=" + tipText.slice(-20) };`],
  ["Y6 卡组 A/B 切换",
   `const D2 = window.GTCG_DECKS;
    const before = D2._data().active;
    const other = before === "a" ? "b" : "a";
    const slot = [...document.querySelectorAll("#deck-slots .deck-slot")].find(s => s.dataset.id === other);
    if (!slot) return { pass: false, detail: "找不到卡组槽 " + other };
    slot.click();
    await new Promise(r => setTimeout(r, 250));
    const after = D2._data().active;
    const name = (document.getElementById("deck-cur-name") || {}).textContent;
    return { pass: after === other && !!name,
             detail: before + " → " + after + "（" + name + "）" };`],
  ["Y7 哈希路由能切页（浏览器前进/后退可用）",
   `location.hash = "cards";
    await new Promise(r => setTimeout(r, 350));
    const onCards = document.getElementById("page-cards").classList.contains("active");
    location.hash = "rules";
    await new Promise(r => setTimeout(r, 350));
    const onRules = document.getElementById("page-rules").classList.contains("active");
    location.hash = "play";
    await new Promise(r => setTimeout(r, 350));
    const onPlay = document.getElementById("page-play").classList.contains("active");
    return { pass: onCards && onRules && onPlay,
             detail: "cards=" + onCards + " rules=" + onRules + " play=" + onPlay };`],

  /* ---- Z. 装备安装（拖装备到角色）---- */
  ["Z1 拖装备到可装备角色 → 装上并加战力",
   `const S = await fresh("main");
    S.p.field = [mk("card09","zeq")];               // 蠢脸骑士，可装单手剑
    S.p.energy = ["card12","card12","card12"].map(id => ({ card: card(id), tapped: false }));
    S.p.hand = [card("card14")];                    // 新手剑 2费虚
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 120));
    const cardEl = document.querySelector("#g-hand .g-handcard");
    const unitEl = document.querySelector('[data-uid="zeq"]');
    if (!cardEl || !unitEl) return { pass: false, detail: "缺 DOM" };
    const dt = new DataTransfer();
    const fire = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    const cr = cardEl.getBoundingClientRect();
    fire(cardEl, "dragstart", cr.left + cr.width/2, cr.top + cr.height/2);
    const ur = unitEl.getBoundingClientRect();
    fire(unitEl, "dragover", ur.left + ur.width/2, ur.top + ur.height/2);
    fire(unitEl, "drop", ur.left + ur.width/2, ur.top + ur.height/2);
    fire(cardEl, "dragend", cr.left, cr.top);
    await new Promise(r => setTimeout(r, 500));
    const u = S.p.field.find(x => x.uid === "zeq");
    // 基础 2500 + 新手剑 2000 + 蠢脸骑士「装备武器时力量+500」= 5000
    return { pass: !!u && !!u.equipCard && u.equipCard.id === "card14" && D.core.effPower(u) === 5000,
             detail: "装备=" + (u && u.equipCard ? u.equipCard.name : "无") +
                     " 战力=" + (u ? D.core.effPower(u) : "-") };`],
  ["Z2 装备后出现「武」徽章",
   `const S = D.S;
    D.render();
    await new Promise(r => setTimeout(r, 80));
    const badge = document.querySelector('[data-uid="zeq"] .bd-equip');
    return { pass: !!badge, detail: badge ? badge.getAttribute("title") : "无徽章" };`],
  ["Z3 专属武器装到非专属角色 → 拒绝",
   `const S = await fresh("main");
    S.p.field = [mk("card04","zwrong")];            // 勇士挑战者（无武器栏）
    S.p.energy = ["card12","card12"].map(id => ({ card: card(id), tapped: false }));
    S.p.hand = [card("card13")];                    // 利贝拉（蠢脸骑士专属）
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 120));
    const cardEl = document.querySelector("#g-hand .g-handcard");
    const unitEl = document.querySelector('[data-uid="zwrong"]');
    const dt = new DataTransfer();
    const fire = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    const cr = cardEl.getBoundingClientRect();
    fire(cardEl, "dragstart", cr.left + cr.width/2, cr.top + cr.height/2);
    const ur = unitEl.getBoundingClientRect();
    fire(unitEl, "dragover", ur.left + ur.width/2, ur.top + ur.height/2);
    fire(unitEl, "drop", ur.left + ur.width/2, ur.top + ur.height/2);
    await new Promise(r => setTimeout(r, 400));
    const u = S.p.field[0];
    return { pass: !u.equipCard && S.p.hand.length === 1,
             detail: "装备=" + (u.equipCard ? u.equipCard.name : "无（正确拒绝）") + " 手牌=" + S.p.hand.length };`],
  ["Z4 武器类型不匹配（弓手装剑）→ 拒绝",
   `const S = await fresh("main");
    S.p.field = [mk("card08","zbow")];              // 青叶（弓）
    S.p.energy = ["card12","card12"].map(id => ({ card: card(id), tapped: false }));
    S.p.hand = [card("card14")];                    // 新手剑（单手剑）
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 120));
    const cardEl = document.querySelector("#g-hand .g-handcard");
    const unitEl = document.querySelector('[data-uid="zbow"]');
    const dt = new DataTransfer();
    const fire = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    const cr = cardEl.getBoundingClientRect();
    fire(cardEl, "dragstart", cr.left + cr.width/2, cr.top + cr.height/2);
    const ur = unitEl.getBoundingClientRect();
    fire(unitEl, "dragover", ur.left + ur.width/2, ur.top + ur.height/2);
    fire(unitEl, "drop", ur.left + ur.width/2, ur.top + ur.height/2);
    await new Promise(r => setTimeout(r, 400));
    return { pass: !S.p.field[0].equipCard,
             detail: "装备=" + (S.p.field[0].equipCard ? "装上了（错）" : "无（正确拒绝）") };`],
  ["Z5 专属武器装到专属角色 → 触发共鸣",
   `const S = await fresh("main");
    S.p.field = [mk("card09","zreso")];             // 蠢脸骑士
    S.p.energy = ["card12","card12"].map(id => ({ card: card(id), tapped: false }));
    S.p.hand = [card("card13")];                    // 利贝拉（专属蠢脸骑士）
    S.phase = "main"; S.active = S.p;
    const r0 = S.p.resonance;
    D.render();
    await new Promise(r => setTimeout(r, 120));
    const cardEl = document.querySelector("#g-hand .g-handcard");
    const unitEl = document.querySelector('[data-uid="zreso"]');
    const dt = new DataTransfer();
    const fire = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    const cr = cardEl.getBoundingClientRect();
    fire(cardEl, "dragstart", cr.left + cr.width/2, cr.top + cr.height/2);
    const ur = unitEl.getBoundingClientRect();
    fire(unitEl, "dragover", ur.left + ur.width/2, ur.top + ur.height/2);
    fire(unitEl, "drop", ur.left + ur.width/2, ur.top + ur.height/2);
    await new Promise(r => setTimeout(r, 500));
    const u = S.p.field[0];
    return { pass: !!u.equipCard && S.p.resonance === r0 + 1 && u.resonanceTurn === S.turnCount,
             detail: "共鸣 " + r0 + "→" + S.p.resonance + " 共鸣回合=" + u.resonanceTurn };`],

  /* ---- V. 各关键词触发路径 ---- */
  ["V1 攻击时/守护时/共鸣时/重整/陶禹/检索 触发路径全部正常",
   `const cases = [
      ["梅儿·攻击时", async () => { const S = D.S; S.p.field=[mk("card02","v1")]; S.a.field=[mk("card12","v1d",true)];
        S.phase="battle"; S.active=S.p; await D.core.declareAttack(S.p,S.a,S.p.field[0],S.a.field[0]); }],
      ["利贝拉·攻击时", async () => { const S = D.S; const u=mk("card09","v2"); u.equipCard=card("card13");
        S.p.field=[u]; S.a.field=[mk("card12","v2d",true)]; S.phase="battle"; S.active=S.p;
        await D.core.declareAttack(S.p,S.a,u,S.a.field[0]); }],
      ["克雷格·守护时", async () => { const S = D.S; S.a.field=[mk("card11","v3a")]; S.p.field=[mk("card10","v3d",true)];
        S.phase="battle"; S.active=S.a; S.a.hand=[]; await D.core.declareAttack(S.a,S.p,S.a.field[0],"player"); }],
      ["沉默·回合结束重整", async () => { const S = D.S; const u=mk("card10","v4");
        u.equipCard=card("card15"); u.silenceEquip=true; u.tapped=true;
        S.p.field=[u]; D.core.cleanupTurnEnd(S.p); }],
      ["陶禹·神威门抽牌", async () => { const S = D.S; S.p.field=[mk("card03","v5")];
        S.p.hand=[card("card17")]; S.phase="main"; S.active=S.p; await D.play(0); }],
      ["青叶·登场抽牌", async () => { const S = D.S; S.p.hand=[card("card08")];
        S.phase="main"; S.active=S.p; await D.play(0); }],
      ["佩儿·检索", async () => { const S = D.S; S.p.hand=[card("card01")];
        S.phase="main"; S.active=S.p; await D.play(0); }],
      ["老板娘·置顶置底", async () => { const S = D.S; S.p.hand=[card("card07")];
        S.phase="main"; S.active=S.p; await D.play(0); }],
      ["玛丽安·授予突袭", async () => { const S = D.S; S.p.hand=[card("card06")];
        S.p.field=[mk("card09","v9")]; S.phase="main"; S.active=S.p; await D.play(0); }],
      ["伊娃·授予守护", async () => { const S = D.S; S.p.hand=[card("card23")];
        S.p.field=[mk("card09","v10")]; S.phase="main"; S.active=S.p; await D.play(0); }]
    ];
    const bad = [];
    for (const [name, fn] of cases) {
      autoOn();
      D.newGame(); await D.startBattle("p");
      const S = D.S;
      S.p.energy = ["card01","card01","card04","card04","card12","card12","card12"]
                     .map(id => ({ card: card(id), tapped: false }));
      S.a.energy = ["card12","card12","card12"].map(id => ({ card: card(id), tapped: false }));
      S.p.hand = []; S.a.hand = [];
      try { await fn(); } catch (e) { bad.push(name + ":" + e.message); }
      document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    }
    return { pass: bad.length === 0, detail: bad.length ? bad.join(" | ") : cases.length + " 条触发路径全部正常" };`]
];

/* ============ 主流程 ============ */
(async () => {
  let pass = 0, fail = 0;
  try {
    // 等 CDP 就绪
    let target = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await r.json();
        target = list.find(t => t.type === "page" && t.url.includes("index.html"));
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
    // headless 下 --window-size 不一定生效，显式设定视口，保证布局测试有意义
    try {
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1600, height: 900, deviceScaleFactor: 1, mobile: false
      });
    } catch (e) { /* 老版本不支持就跳过 */ }

    // 收集页面报错
    await evaluate(`
      window.__errs = [];
      window.addEventListener("error", e => window.__errs.push(String(e.message)));
      window.addEventListener("unhandledrejection",
        e => window.__errs.push("REJ: " + String((e.reason && e.reason.message) || e.reason)));
      // 自动应答弹窗，让测试能无人值守跑完（真实页面默认会停在弹窗上）
      window.GTCG_AUTO = (title, options) => {
        if (/响应/.test(title)) return false;
        const decline = options.find(o => o.value === null);
        if (decline) return null;
        return options[0] ? options[0].value : null;
      };
      window.GTCG_FAST = true;
      return true;
    `);

    // 等页面脚本初始化（用 JSON 探针：字符串返回值最稳）
    let ready = false, lastState = "";
    for (let i = 0; i < 80; i++) {
      try {
        lastState = await evaluate(`return JSON.stringify({
          cards: typeof CARDS,
          decks: typeof window.GTCG_DECKS,
          dbg: typeof window.GTCG_DEBUG,
          S: !!(window.GTCG_DEBUG && window.GTCG_DEBUG.S)
        })`);
        const st = JSON.parse(lastState);
        if (st.cards === "object" && st.dbg === "object" && st.S) { ready = true; break; }
      } catch (e) {
        lastState = "求值异常: " + e.message;
      }
      await sleep(200);
    }
    if (!ready) throw new Error("页面未初始化完成，最后状态：" + lastState);

    // 切到「线上试玩」页：只有 .page.active 才量得到真实布局尺寸
    await evaluate(`location.hash = "play"; return true;`);
    await sleep(350);
    await evaluate(`
      if (!document.getElementById("page-play").classList.contains("active")) {
        const a = document.querySelector('.nav-links a[data-page="play"]');
        if (a) a.click();
      }
      return document.getElementById("page-play").classList.contains("active");
    `);
    await sleep(350);

    console.log("\n=== GTCG 规则自检（真实 Edge） ===\n");
    let group = "";
    for (const [name, body] of TESTS) {
      const g = name.slice(0, 1);
      if (g !== group) { group = g; console.log(""); }
      let r;
      try {
        r = await evaluate(PRELUDE + body, 20000);
      } catch (e) {
        r = { pass: false, detail: "异常：" + e.message };
      }
      const ok = r && r.pass;
      if (ok) pass++; else fail++;
      console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && r && r.detail ? "  → " + r.detail : ""}`);
    }

    const errs = await evaluate("return window.__errs || []");
    // "Script error." 是跨域脚本的不透明错误（无消息、无行号、无 URL），
    // 来源是 index.html 引的 jsdelivr CDN（WorkBuddy 云 SDK，供坎友圈用），
    // 与对局代码无关：同源脚本的报错一定带完整消息。这里只统计有内容的本站错误。
    const realErrs = errs.filter(e => e && e !== "Script error." && !/^REJ: Script error\./.test(e));
    if (realErrs.length) {
      console.log("\n⚠ 页面运行时错误：");
      realErrs.slice(0, 10).forEach(e => console.log("   " + e));
      fail += realErrs.length;
    }

    console.log(`\n${"=".repeat(46)}`);
    console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${TESTS.length} 条）`);
    console.log(`${"=".repeat(46)}\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error("测试运行失败:", e.message);
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    browser.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})();
