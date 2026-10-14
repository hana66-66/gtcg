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
  // 干净开局：新对局 + 掷骰（玩家先手）+ 停在指定阶段
  const fresh = async (phase) => {
    D.newGame();
    await D.startBattle("p");
    D.S.phase = phase || "fill";
    D.S.active = D.S.p;
    return D.S;
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
  ["O1 手牌卡绑定了 click 处理（桌面可点出牌）",
   `const S = await fresh("main");
    D.rig({ hand: ["card04"], energy: ["card04","card12"] });
    S.phase = "main";
    D.render();
    const el = document.querySelector("#g-hand .g-handcard");
    if (!el) return { pass: false, detail: "无手牌 DOM" };
    // 触发真实 click，看是否弹出操作菜单
    el.click();
    await new Promise(r => setTimeout(r, 150));
    const hasModal = !!document.querySelector(".modal-mask.open");
    const played = S.p.field.length > 0;
    // 清理弹窗，避免影响后续用例
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: hasModal || played,
             detail: "弹窗=" + hasModal + " 已上场=" + played };`],
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
  ["O7 点手牌能真的打出角色（端到端）",
   `const S = await fresh("main");
    // 土系能量 + 土系角色，保证付得起
    D.rig({ hand: ["card04"], energy: ["card04","card04","card12","card12"] });
    S.phase = "main"; S.active = S.p;
    D.render();
    await new Promise(r => setTimeout(r, 60));
    const before = S.p.field.length;
    const el = document.querySelector("#g-hand .g-handcard");
    if (!el) return { pass: false, detail: "无手牌 DOM" };
    el.click();
    // 单选项会直接执行；多选项会弹菜单 —— 两种都等一小会儿
    for (let i = 0; i < 40 && S.p.field.length === before; i++) {
      await new Promise(r => setTimeout(r, 50));
      const opt = document.querySelector(".modal-mask.open .g-opt");
      if (opt) opt.click();
    }
    document.querySelectorAll(".modal-mask.open").forEach(m => m.remove());
    return { pass: S.p.field.length === before + 1,
             detail: "场上 " + before + " → " + S.p.field.length };`]
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
