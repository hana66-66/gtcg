/* GTCG 线上试玩 v3 - 规则 0.1（你 vs AI）
 * ---------------------------------------------------------------
 * 本版相对 v2 的变化：
 *   1. 卡牌行为改为「登记表」驱动，删除 onEnter / resolveEvent 里成串的
 *      if (id === "cardXX")，新增卡牌只需加一条记录，不再改控制流。
 *   2. 阶段推进、AI 出牌决策同样改为表驱动。
 *   3. 战斗结算补齐规则书 0.1 缺漏：
 *        · 对局准备「双方各从手牌选 1 张填入能量区」（规则 2）
 *        · 利贝拉 [攻击时] 改为玩家点选目标，本回合战力 -1000（规则 10）
 *        · 旅馆老板娘剩余牌可分别置顶/置底（规则 7）
 *        · 克雷格 [守护时] +3000 仅在守护时生效
 *   4. 界面：单位卡放大为「卡图 + 名字 + 战力 + 关键词徽章」，加入战斗反馈动效。
 *
 * 依赖 js/cards-data.js
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const byId = id => CARDS.find(c => c.id === id);
  const SWORD = byId("card24");

  /* ============================================================
     一、常量
     ============================================================ */

  // 阶段：抽牌 → 填能 → 主要 → 战斗（进入下一阶段后不能再做上一阶段的操作）
  const PHASE_ORDER = ["draw", "fill", "main", "battle"];
  const PHASE_NAME = { draw: "抽牌阶段", fill: "填能阶段", main: "主要阶段", battle: "战斗阶段", end: "回合结束" };
  const PHASE_BUTTON = {
    fill: "跳过填能 → 主要阶段",
    main: "进入战斗阶段 →",
    battle: "结束回合"
  };

  const RESONANCE_MAX = 12;      // 共鸣值上限（规则 4）
  const HAND_START = 5;          // 起手张数（规则 2）
  const DECK_SIZE = 40;          // 卡组张数（规则 1）

  // 骰面点数分布（9 格中的哪几格有圆点）
  const DIE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  /* ============================================================
     二、卡牌行为登记表
     ------------------------------------------------------------
     原先 onEnter / resolveEvent 里是一长串 if (id === "cardXX")，
     每加一张卡就要再插一个分支。这里改成按卡号登记的处理器：
       · ON_ENTER    角色 [登场时]
       · ON_EVENT    事件卡结算
       · ON_ATTACK   攻击者 [攻击时]
       · ON_GUARD    防守方 [守护时]
       · ON_RESONATE 专属武器装到专属角色时的 [共鸣时]
       · ON_EQUIP    装备武器时的静态加成
       · AI_WANTS    事件卡的 AI 出牌意愿（决定 AI 打不打）
     所有处理器统一签名 handler(ctx)，ctx 见下方 makeCtx()。
     ============================================================ */

  const ON_ENTER = {
    // 仙山拳名家佩儿：查看牌库顶 5 张，取 1 张「神威门」，其余置牌库底
    card01: async ctx => {
      const { side, isAI, api } = ctx;
      const top = side.deck.splice(0, Math.min(5, side.deck.length));
      const hits = top.map((c, k) => ({ c, k })).filter(x => (x.c.factions || []).includes("神威门"));
      let i = hits.length ? hits[0].k : -1;
      // 多张「神威门」时由玩家本人点选（规则 7：系统不代为决定）
      if (hits.length > 1 && !isAI && !window.GTCG_AUTO) {
        i = await api.reveal("「佩儿」[登场时]：查看你的牌库顶 —— 请选择加入手牌的「神威门」卡",
          top, -1, hits.map(x => x.k));
      }
      if (i >= 0) {
        const got = top[i];
        side.hand.push(got);
        side.deck.push(...top.filter((_, k) => k !== i));
        api.log(`「佩儿」[登场时]：查看牌库顶 ${top.length} 张${hits.length > 1 ? `（其中 ${hits.length} 张「神威门」卡）` : ""} → 将「${got.name}」加入手牌，其余 ${top.length - 1} 张置于牌库底`, "g-hot");
      } else {
        side.deck.push(...top);
        api.log(`「佩儿」[登场时]：查看牌库顶 ${top.length} 张（${top.map(c => c.name).join("、")}）——其中没有「神威门」卡，全部置于牌库底`);
      }
      if (!isAI && hits.length <= 1) await api.reveal("「佩儿」[登场时]：查看你的牌库顶", top, i);
    },

    // 工程师玛丽安：指定己方一名其他角色，本回合获得 [突袭]
    card06: async ctx => {
      const { side, unit, isAI, api } = ctx;
      const others = side.field.filter(x => x !== unit);
      if (!others.length) return;
      const t = await api.pickAlly(others, isAI,
        "「工程师玛丽安」[登场时]：使一名其他角色本回合获得[突袭]");
      if (!t) return;
      t.raidTurn = api.turn();
      api.log(`「玛丽安」[登场时]：「${t.card.name}」本回合获得[突袭]`);
    },

    // 旅馆老板娘：查看牌库顶 3 张，取 1 张加入手牌，其余分别置于牌库顶或牌库底
    card07: async ctx => {
      const { side, isAI, api } = ctx;
      const top = side.deck.splice(0, Math.min(3, side.deck.length));
      if (!top.length) return;
      let pick;
      if (isAI || window.GTCG_AUTO) {
        pick = [...top].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0];
      } else {
        pick = await api.choose("「旅馆老板娘」[登场时]：从牌库顶 3 张选 1 张加入手牌",
          top.map(c => ({ label: c.name, sub: `${c.type}·费用${c.cost ?? "-"}·${c.attr}`, img: c.img, value: c })));
      }
      const rest = top.filter(c => c !== pick);
      side.hand.push(pick);
      // 剩余牌由玩家逐张决定置顶或置底（规则 7）
      if (rest.length && !isAI && !window.GTCG_AUTO) {
        const toTop = await api.arrange(rest);
        side.deck.unshift(...toTop);
        side.deck.push(...rest.filter(c => !toTop.includes(c)));
        api.log(`「旅馆老板娘」[登场时]：取「${pick.name}」，其余 ${rest.length} 张（置顶 ${toTop.length} / 置底 ${rest.length - toTop.length}）`);
      } else {
        side.deck.unshift(...rest);
        api.log(`「旅馆老板娘」[登场时]：从牌库顶 3 张取「${pick.name}」，其余置于牌库顶`);
      }
    },

    // 森林妖精青叶：此角色不能攻击；[登场时] 抽 1 张
    card08: ctx => {
      const { side, unit, api } = ctx;
      unit.cannotAttack = true;
      api.draw(side, 1);
      api.log(`「青叶」[登场时]：抽 1 张（此角色不能攻击）`);
    },

    // 骑士团长伊娃：指定己方一名其他角色，获得 [守护]（永久，规则 9）
    card23: async ctx => {
      const { side, unit, isAI, api } = ctx;
      const others = side.field.filter(x => x !== unit);
      if (!others.length) return;
      const t = await api.pickAlly(others, isAI,
        "「骑士团长伊娃」[登场时]：使一名其他角色获得[守护]（永久）");
      if (!t) return;
      t.grantedGuard = true;
      api.log(`「伊娃」[登场时]：「${t.card.name}」获得[守护]（永久）`);
    }
  };

  const ON_EVENT = {
    // 霸王冰焰弹：抽 2 张，然后击破对方 1 名角色
    card16: async ctx => {
      const { side, isAI, api } = ctx;
      api.draw(side, 2);
      const foes = api.foe(side).field;
      if (!foes.length) return;
      const t = isAI || window.GTCG_AUTO
        ? [...foes].sort((a, b) => api.power(b) - api.power(a))[0]
        : await api.choose("「霸王冰焰弹」：选择对方 1 名角色击破",
            foes.map(x => ({ label: x.card.name, sub: `战力 ${api.power(x)}`, img: x.card.img, value: x })));
      if (!t) return;
      api.log(`「霸王冰焰弹」击破「${t.card.name}」！`, "g-hot");
      api.destroy(t, api.foe(side));
    },

    // 佩儿的特训：己方所有角色本回合战力 +1000
    card17: ctx => {
      const { side, api } = ctx;
      side.field.forEach(u => { u.tmpBuff += 1000; api.fx(u, "+1000", "buff"); });
      api.log("己方全体本回合战力 +1000");
    },

    // 塞西尔的演唱会：抽 2 张，然后弃置 1 张手牌
    card18: async ctx => {
      const { side, isAI, api } = ctx;
      api.draw(side, 2);
      if (!side.hand.length) return;
      const c = isAI || window.GTCG_AUTO
        ? [...side.hand].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0]
        : await api.choose("「塞西尔的演唱会」：弃置 1 张手牌",
            side.hand.map(x => ({ label: x.name, sub: `${x.type}·费用${x.cost ?? "-"}`, img: x.img, value: x })));
      if (!c) return;
      side.hand.splice(side.hand.indexOf(c), 1);
      side.discard.push(c);
      api.log(`弃置「${c.name}」`);
    },

    // 她一定会喜欢的：从废弃区选 1 张置于费用区
    card19: async ctx => {
      const { side, isAI, api } = ctx;
      if (!side.discard.length) return;
      const c = isAI || window.GTCG_AUTO
        ? [...side.discard].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0]
        : await api.choose("「她一定会喜欢的」：从废弃区选 1 张置入能量区",
            side.discard.map(x => ({ label: x.name, sub: `${x.type}·费用${x.cost ?? "-"}·${x.attr}`, img: x.img, value: x })));
      if (!c) return;
      side.discard.splice(side.discard.indexOf(c), 1);
      side.energy.push({ card: c, tapped: false });
      api.log(`「${c.name}」从废弃区置入能量区`);
    },

    // 我只是路过：己方 1 名角色返回手牌，然后抽 1 张
    card20: async ctx => {
      const { side, isAI, api } = ctx;
      if (side.field.length) {
        const t = isAI || window.GTCG_AUTO
          ? (side.field.find(u => u.dmgTaken > 0) || [...side.field].sort((a, b) => api.power(b) - api.power(a))[0])
          : await api.choose("「我只是路过」：将己方 1 名角色返回手牌",
              side.field.map(x => ({ label: x.card.name, sub: `战力 ${api.power(x)}（装备进废弃区）`, img: x.card.img, value: x })));
        if (t) {
          api.bounce(side, t);
          api.log(`「${t.card.name}」返回手牌`);
        }
      }
      api.draw(side, 1);
    },

    // 让人想要哭泣的场景：使对手 1 名角色疲劳
    card21: async ctx => {
      const { side, isAI, api } = ctx;
      const foes = api.foe(side).field.filter(u => !u.tapped);
      if (!foes.length) return;
      const t = isAI || window.GTCG_AUTO
        ? [...foes].sort((a, b) => api.power(b) - api.power(a))[0]
        : await api.choose("「让人想要哭泣的场景」：使对手 1 名角色疲劳",
            foes.map(x => ({ label: x.card.name, sub: `战力 ${api.power(x)}`, img: x.card.img, value: x })));
      if (!t) return;
      t.tapped = true;
      api.log(`「${t.card.name}」疲劳`);
    },

    // 钢铁泰坦，出击！：对手所有角色本回合战力 -2000
    card22: ctx => {
      const { side, api } = ctx;
      api.foe(side).field.forEach(u => { u.tmpBuff -= 2000; api.fx(u, "-2000", "debuff"); });
      api.log("对方全体本回合战力 -2000");
    }
  };

  // [攻击时]：宣告攻击、进入战斗结算前触发
  const ON_ATTACK = {
    // 仙山拳名家梅儿：此角色战力 +2000，直到此次战斗结束
    card02: ctx => {
      const { unit, api } = ctx;
      unit.battleBuff += 2000;
      api.log("「梅儿」[攻击时]：战力 +2000（此次战斗）");
      api.fx(unit, "+2000", "buff");
    },
    // 利贝拉（装备）：选择对手 1 名角色，其本回合战力 -1000
    card13: async ctx => {
      const { side, isAI, api } = ctx;
      const foes = api.foe(side).field;
      if (!foes.length) return;
      const t = isAI || window.GTCG_AUTO
        ? (foes.includes(ctx.target) ? ctx.target : [...foes].sort((a, b) => api.power(b) - api.power(a))[0])
        : await api.choose("「利贝拉」[攻击时]：选择对手 1 名角色，其本回合战力 -1000",
            foes.map(x => ({ label: x.card.name, sub: `战力 ${api.power(x)} → ${Math.max(0, api.power(x) - 1000)}`, img: x.card.img, value: x })));
      if (!t) return;
      t.tmpBuff -= 1000;
      api.log(`「利贝拉」[攻击时]：「${t.card.name}」本回合战力 -1000`);
      api.fx(t, "-1000", "debuff");
      api.checkDestroy(t, api.foe(side));   // 战力被减到 0 ＝ 被击破（规则 6）
    }
  };

  // [守护时]：进行守护时触发
  const ON_GUARD = {
    // 真正的勇士克雷格：战力 +3000，直到此次战斗结束
    card10: ctx => {
      const { unit, api } = ctx;
      unit.battleBuff += 3000;
      api.log("「克雷格」[守护时]：战力 +3000（此次战斗）");
      api.fx(unit, "+3000", "buff");
    }
  };

  // [共鸣时]：专属武器装到专属角色身上的那一刻
  const ON_RESONATE = {
    card13: ctx => {
      const { side, api } = ctx;
      api.log("「利贝拉」[共鸣时]：获得 1 点共鸣值");
      api.resonance(side, 1);
    }
  };

  // 装备武器时的静态加成
  const ON_EQUIP = {
    card09: ctx => {   // 蠢脸骑士：装备武器时力量（战力）+500
      ctx.bearer.bonus += 500;
      ctx.api.log("「蠢脸骑士」装备武器：力量 +500");
    }
  };

  // AI 事件卡出牌意愿：返回 true 才考虑打出
  const AI_WANTS = {
    card16: (me, foe, api) => foe.field.length > 0,
    card17: (me, foe, api) => me.field.some(u => api.canAttack(u, me)),
    card18: (me, foe, api) => me.deck.length >= 3,
    card19: (me, foe, api) => me.discard.some(c => (c.cost ?? 0) >= 3) && me.energy.length < 6,
    card20: (me, foe, api) => me.field.some(u => u.dmgTaken > 0 || u.tapped),
    card21: () => false,   // 留作[响应]，不在自己回合主动打出
    card22: (me, foe, api) => me.field.some(u => api.canAttack(u, me))
  };

  /* ============================================================
     三、状态
     ============================================================ */

  let S = null;
  let uidSeq = 0;
  let busy = false;          // 结算中：屏蔽玩家输入
  let dragCard = null;       // 正在拖拽的手牌
  let dragUnit = null;       // 正在拖拽的己方单位

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 随机兜底牌组（所选卡组缺失/非法时使用）
  function randomDeck() {
    const deck = [];
    CARDS.filter(c => c.id !== SWORD.id).forEach(c => { for (let i = 0; i < 4; i++) deck.push(c); });
    return shuffle(deck).slice(0, DECK_SIZE);
  }

  // 按「我的卡组」构筑发牌；deckId 为空或卡组非法则回退随机
  function buildDeck(deckId) {
    const D = window.GTCG_DECKS;
    if (D && deckId && D.valid(deckId)) {
      const ids = D.expand(deckId);
      const cards = ids.map(byId).filter(Boolean);
      if (cards.length === ids.length) return shuffle(cards);
    }
    return randomDeck();
  }

  function newSide(name, deckId) {
    const D = window.GTCG_DECKS;
    const legal = !!(D && deckId && D.valid(deckId));
    return {
      name,
      deckId: legal ? deckId : null,
      deckName: legal ? `${D.name(deckId)}（卡组 ${deckId.toUpperCase()}）` : "随机卡组",
      deck: buildDeck(legal ? deckId : null),
      hand: [], field: [], energy: [], discard: [],
      resonance: 0,
      sword: { onField: false, tapped: false, summonedTurn: -1 },
      turns: 0,
      filledThisTurn: false,
      ready: false            // 对局准备：是否已选好开局能量（规则 2）
    };
  }

  function newUnit(card) {
    return {
      uid: "u" + (++uidSeq),
      card,
      tapped: false,
      playedTurn: S ? S.turnCount : 0,
      bonus: 0,          // 装备/静态加成（永久）
      tmpBuff: 0,        // 本回合内的战力增减（回合结束恢复）
      dmgTaken: 0,       // 反伤扣减（回合结束恢复）
      battleBuff: 0,     // 单次战斗内的加成
      raidTurn: null,    // 获得[突袭]的回合
      grantedGuard: false,
      cannotAttack: false,
      refreshedNoAttack: false,
      resonanceTurn: null,
      silenceEquip: false,
      equipCard: null
    };
  }

  /* ============================================================
     四、规则原语
     ============================================================ */

  const effPower = u => Math.max(0, (u.card.power || 0) + u.bonus + u.tmpBuff + u.battleBuff - u.dmgTaken);
  const hasGuard = u => u.card.keywords.includes("守护") || u.grantedGuard;
  const hasRaid = u => u.card.keywords.includes("突袭") || u.raidTurn === S.turnCount;

  // 当回合上场的角色不能攻击；共鸣状态当回合即可攻击（规则 5）
  function canAttack(u) {
    if (!u || u.tapped || u.cannotAttack || u.refreshedNoAttack) return false;
    if (u.playedTurn === S.turnCount && u.resonanceTurn !== S.turnCount) return false;
    return true;
  }
  const swordCanAttack = side =>
    side.sword.onField && !side.sword.tapped && side.sword.summonedTurn !== S.turnCount;

  // 可攻击的对手角色：默认仅疲劳（横置）；[突袭] 可打活跃（规则 6）
  function attackableTargets(atkUnit, defSide) {
    return defSide.field.filter(t => atkUnit && hasRaid(atkUnit) ? true : t.tapped);
  }
  const opp = side => (side === S.p ? S.a : S.p);

  // 战力被减到 0 ＝ 被击破（规则 6）
  function checkDestroy(unit, side) {
    if (side.field.includes(unit) && effPower(unit) <= 0) {
      destroy(unit, side);
      return true;
    }
    return false;
  }

  function destroy(unit, side) {
    const i = side.field.indexOf(unit);
    if (i < 0) return;
    side.field.splice(i, 1);
    side.discard.push(unit.card);
    if (unit.equipCard) side.discard.push(unit.equipCard);   // 连同装备一起进废弃区
    fxAt(unit.uid, "💀", "kill");
    log(`${side.name} 的「${unit.card.name}」被击破`, "g-hot");
  }

  // 返回手牌（装备进废弃区）
  function bounce(side, unit) {
    const i = side.field.indexOf(unit);
    if (i < 0) return;
    side.field.splice(i, 1);
    if (unit.equipCard) side.discard.push(unit.equipCard);
    side.hand.push(unit.card);
  }

  // 命中玩家本体 → +1 共鸣值；满 12 → 召唤冠军之剑（规则 6）
  function addResonance(side, n) {
    if (side.resonance >= RESONANCE_MAX) return;
    side.resonance = Math.min(RESONANCE_MAX, side.resonance + n);
    log(`💥 ${side.name} 命中对方本体，共鸣值 +${n}（${side.resonance}/${RESONANCE_MAX}）`, "g-hot");
    if (side.resonance >= RESONANCE_MAX && !side.sword.onField) {
      side.sword.onField = true;
      side.sword.tapped = false;
      side.sword.summonedTurn = S.turnCount;
      log(`✨ 共鸣值满 ${RESONANCE_MAX} ——「冠军之剑」从 EX ZONE 移至 ${side.name} 的战场！（当回合不能攻击）`, "g-hot");
      fxAt(side === S.p ? "z-ex" : "z-ex-a", "✦ 冠军之剑 ✦", "summon");
    }
    render();
  }

  function drawCards(side, n) {
    for (let i = 0; i < n; i++) {
      if (!side.deck.length) { endGame(opp(side), `${side.name} 必须抽牌但牌库已空`); return; }
      side.hand.push(side.deck.shift());
    }
  }

  // 回合结束：本回合内被降低/提升的战力恢复原值（双方都恢复，规则 3）
  function cleanupTurnEnd(side) {
    [S.p, S.a].forEach(s => s.field.forEach(u => {
      u.tmpBuff = 0; u.dmgTaken = 0; u.battleBuff = 0;
    }));
    side.field.forEach(u => {
      u.raidTurn = null;
      u.refreshedNoAttack = false;
      // 「沉默」[共鸣中]：回合结束时重整
      if (u.silenceEquip && u.tapped) {
        u.tapped = false;
        u.refreshedNoAttack = true;
        log(`「沉默」[共鸣中]：「${u.card.name}」回合结束重整（本回合不能攻击）`);
      }
      u.resonanceTurn = null;
    });
  }

  /* ============================================================
     五、日志 / 提示 / 动效
     ============================================================ */

  function log(msg, cls) {
    const el = $("g-log");
    if (!el) return;
    const d = document.createElement("div");
    d.className = "g-log-line" + (cls ? " " + cls : "");
    d.textContent = msg;
    el.prepend(d);
    while (el.children.length > 80) el.removeChild(el.lastChild);
  }

  let toastTimer = null;
  function gToast(msg) {
    if (!msg) return;
    let el = $("g-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "g-toast";
      el.className = "deck-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 1900);
  }

  // ---- 战斗反馈动效：定位到某个 DOM 元素上方飘字 / 闪动 ----
  function fxLayer() {
    let l = $("g-fx");
    if (!l) {
      l = document.createElement("div");
      l.id = "g-fx";
      document.body.appendChild(l);
    }
    return l;
  }
  // 按 uid（或直接元素 id）找到屏幕坐标，飘一段文字
  function fxAt(uidOrEl, text, cls) {
    if (window.GTCG_FAST) return;
    const el = typeof uidOrEl === "string"
      ? (document.querySelector(`[data-uid="${uidOrEl}"]`) || $(uidOrEl))
      : uidOrEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.className = "g-fx-float " + (cls || "");
    d.textContent = text;
    d.style.left = (r.left + r.width / 2) + "px";
    d.style.top = (r.top + r.height * 0.25) + "px";
    fxLayer().appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }
  // 单位闪动（受击 / 攻击）
  function fxShake(uid, cls) {
    if (window.GTCG_FAST) return;
    const el = document.querySelector(`[data-uid="${uid}"]`);
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;      // 强制重排以重启动画
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 700);
  }
  const fx = (unit, text, cls) => fxAt(unit.uid, text, cls);
  const fxHit = unit => { fxShake(unit.uid, "justHit"); };
  const fxLunge = (unit, dir) => fxShake(unit.uid, "justAttack" + (dir < 0 ? " dl" : " dr"));

  /* ============================================================
     六、弹窗（选择 / 支付 / 亮牌 / 整理）
     ============================================================ */

  // 通用选项弹窗（可被测试钩子接管）
  function choose(title, options) {
    if (window.GTCG_AUTO) return Promise.resolve(window.GTCG_AUTO(title, options));
    return new Promise(res => {
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      const opts = options.map((o, i) => `
        <div class="g-opt" data-i="${i}">
          ${o.img ? `<img src="${o.img}" class="g-opt-img">` : ""}
          <div><b>${o.label}</b>${o.sub ? `<div class="g-opt-sub">${o.sub}</div>` : ""}</div>
        </div>`).join("");
      mask.innerHTML = `<div class="modal col" style="max-width:620px"><h2 style="font-size:20px;color:#fff">${title}</h2><div class="g-opts">${opts}</div></div>`;
      document.body.appendChild(mask);
      mask.querySelectorAll(".g-opt").forEach(el => {
        el.addEventListener("click", () => { mask.remove(); res(options[+el.dataset.i].value); });
      });
    });
  }

  // 亮出牌库顶若干张（检索类效果）：多张可选时进入点选模式
  function revealModal(title, cards, pickedIdx, pickable) {
    const canPick = Array.isArray(pickable) && pickable.length > 1;
    if (window.GTCG_AUTO) return Promise.resolve(canPick ? pickable[0] : pickedIdx);
    return new Promise(res => {
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      const picked = pickedIdx >= 0 ? cards[pickedIdx] : null;
      const sub = canPick
        ? `其中共有 <b style="color:var(--gold)">${pickable.length}</b> 张「神威门」卡 —— 请点选其中 <b>1</b> 张加入手牌，其余 ${cards.length - 1} 张置于牌库底`
        : (picked
            ? `其中含有「神威门」卡：<b style="color:var(--gold)">「${picked.name}」</b>加入手牌，其余 ${cards.length - 1} 张置于牌库底`
            : `其中没有「神威门」卡，${cards.length} 张全部按原顺序置于牌库底`);
      mask.innerHTML = `<div class="modal col" style="max-width:660px">
        <h2 style="font-size:19px;margin-bottom:6px;color:#fff">${title}</h2>
        <div class="g-pay-sub">${sub}</div>
        <div class="g-reveal-grid">${cards.map((c, i) => {
          const can = canPick && pickable.includes(i);
          return `<div class="g-reveal-card${i === pickedIdx ? " picked" : ""}${can ? " pickable" : ""}" data-i="${i}"><img src="${c.img}"><div class="g-reveal-name">${c.name}</div>${can ? `<div class="g-reveal-tag">可加入手牌</div>` : ""}</div>`;
        }).join("")}</div>
        <div class="g-pay-foot"><span class="g-pay-count">共翻开 ${cards.length} 张</span><button class="btn primary" id="g-reveal-ok"${canPick ? " disabled" : ""}>确定</button></div>
      </div>`;
      document.body.appendChild(mask);
      const ok = mask.querySelector("#g-reveal-ok");
      let sel = -1;
      if (canPick) {
        mask.querySelectorAll(".g-reveal-card.pickable").forEach(el => {
          el.addEventListener("click", () => {
            mask.querySelectorAll(".g-reveal-card").forEach(x => x.classList.remove("sel"));
            el.classList.add("sel");
            sel = +el.dataset.i;
            ok.disabled = false;
            ok.textContent = "加入手牌";
          });
        });
      }
      ok.addEventListener("click", () => { mask.remove(); res(canPick ? sel : pickedIdx); });
    });
  }

  // 整理牌库顶/底：逐张切换「置顶 / 置底」，返回置顶的牌
  function arrangeModal(cards) {
    if (window.GTCG_AUTO) return Promise.resolve(cards.slice());
    return new Promise(res => {
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      const toTop = new Set(cards.map((_, i) => i));   // 默认全部置顶
      mask.innerHTML = `<div class="modal col" style="max-width:660px">
        <h2 style="font-size:19px;margin-bottom:6px;color:#fff">「旅馆老板娘」[登场时]：其余牌置于牌库顶或牌库底</h2>
        <div class="g-pay-sub">点一下卡牌即可切换 <b>置顶 ⇄ 置底</b>；置顶的牌会按当前顺序放回牌库顶。</div>
        <div class="g-reveal-grid" id="g-arrange-grid">${cards.map((c, i) =>
          `<div class="g-reveal-card pickable" data-i="${i}"><img src="${c.img}"><div class="g-reveal-name">${c.name}</div><div class="g-reveal-tag" data-tag="${i}">置顶</div></div>`
        ).join("")}</div>
        <div class="g-pay-foot"><span class="g-pay-count" id="g-arrange-count"></span><button class="btn primary" id="g-arrange-ok">确定</button></div>
      </div>`;
      document.body.appendChild(mask);
      const cnt = mask.querySelector("#g-arrange-count");
      const refresh = () => {
        cards.forEach((_, i) => {
          const tag = mask.querySelector(`[data-tag="${i}"]`);
          const on = toTop.has(i);
          tag.textContent = on ? "置顶" : "置底";
          tag.parentElement.classList.toggle("sel", on);
        });
        cnt.textContent = `置顶 ${toTop.size} 张 · 置底 ${cards.length - toTop.size} 张`;
      };
      mask.querySelectorAll(".g-reveal-card").forEach(el => {
        el.addEventListener("click", () => {
          const i = +el.dataset.i;
          if (toTop.has(i)) toTop.delete(i); else toTop.add(i);
          refresh();
        });
      });
      refresh();
      mask.querySelector("#g-arrange-ok").addEventListener("click", () => {
        mask.remove();
        res(cards.filter((_, i) => toTop.has(i)));
      });
    });
  }

  /* ---- 支付费用（规则 4）---- */

  // 自动挑一组可支付的能量卡（不改变状态）
  function pickPayment(side, card) {
    if (card.cost === null) return null;
    const free = side.energy.filter(e => !e.tapped);
    if (free.length < card.cost) return null;
    const picked = [];
    // 单属性卡 → 至少 1 张同属性；多属性卡 → 每种属性各至少 1 张
    const attrs = card.attrs && card.attrs.length ? card.attrs : (card.attr && card.attr !== "无" ? [card.attr] : []);
    for (const a of attrs) {
      const m = free.find(e => !picked.includes(e) && e.card.attr === a);
      if (!m) return null;
      picked.push(m);
    }
    for (const e of free) {
      if (picked.length >= card.cost) break;
      if (!picked.includes(e)) picked.push(e);
    }
    return picked.length >= card.cost ? picked : null;
  }
  const canPay = (side, card) => card.cost === null || !!pickPayment(side, card);
  function tryPay(side, card) {
    const picked = pickPayment(side, card);
    if (!picked) return null;
    picked.forEach(e => e.tapped = true);
    return picked;
  }

  // 玩家手动点选要横置哪几张能量卡
  function choosePayment(side, card) {
    if (window.GTCG_AUTO || card.cost === null || !pickPayment(side, card)) {
      return Promise.resolve(pickPayment(side, card));
    }
    const free = side.energy.filter(e => !e.tapped);
    const attrs = card.attrs && card.attrs.length ? card.attrs : (card.attr && card.attr !== "无" ? [card.attr] : []);
    const needAttr = attrs.length ? attrs[0] : null;
    return new Promise(res => {
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      mask.innerHTML = `<div class="modal col" style="max-width:680px">
        <h2 style="font-size:19px;margin-bottom:6px;color:#fff">支付费用 · ${card.name}</h2>
        <div class="g-pay-sub">费用 <b>${card.cost}</b> · 属性 <b>${card.attr}</b>${needAttr
          ? ` —— 请点选 ${card.cost} 张能量横置支付，其中至少 1 张为 <b>【${needAttr}】</b>属性`
          : ` —— 请点选 ${card.cost} 张能量横置支付`}</div>
        <div class="g-pay-grid">${free.map((e, i) =>
          `<div class="g-pay-tile" data-i="${i}" title="${e.card.name}｜属性${e.card.attr}"><img src="${e.card.img}"><span class="g-pay-attr${needAttr === e.card.attr ? " match" : ""}">${e.card.attr}</span><span class="g-pay-name">${e.card.name}</span></div>`
        ).join("")}</div>
        <div class="g-pay-foot">
          <span id="g-pay-count" class="g-pay-count">已选 0 / ${card.cost}</span>
          <span><button class="btn" id="g-pay-cancel">取消</button> <button class="btn primary" id="g-pay-ok" disabled>确认支付</button></span>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const sel = [];
      const okBtn = mask.querySelector("#g-pay-ok");
      const cnt = mask.querySelector("#g-pay-count");
      const refresh = () => {
        const enough = sel.length === card.cost;
        const attrOk = !needAttr || sel.some(e => e.card.attr === needAttr);
        okBtn.disabled = !(enough && attrOk);
        cnt.textContent = `已选 ${sel.length} / ${card.cost}` + (enough && !attrOk ? `（还需 1 张【${needAttr}】）` : "");
      };
      mask.querySelectorAll(".g-pay-tile").forEach(t => t.addEventListener("click", () => {
        const e = free[+t.dataset.i];
        const at = sel.indexOf(e);
        if (at >= 0) { sel.splice(at, 1); t.classList.remove("sel"); }
        else if (sel.length < card.cost) { sel.push(e); t.classList.add("sel"); }
        refresh();
      }));
      mask.querySelector("#g-pay-cancel").addEventListener("click", () => { mask.remove(); res(null); });
      okBtn.addEventListener("click", () => {
        mask.remove();
        sel.forEach(e => e.tapped = true);
        res(sel.slice());
      });
    });
  }

  // 统一支付入口：AI/测试自动挑，玩家手动点选
  const payFor = (side, card, isAI) =>
    (isAI || window.GTCG_AUTO) ? Promise.resolve(tryPay(side, card)) : choosePayment(side, card);

  const sleep = ms => new Promise(r => setTimeout(r, window.GTCG_FAST ? 0 : ms));

  /* ============================================================
     七、战斗结算（规则 6）
     ============================================================ */

  // 攻击流程：宣告 → [响应] → 守护 → [攻击时] → 结算 → 横置
  async function declareAttack(atkSide, defSide, atkUnit, target) {
    if (S.over) return;
    if (atkSide === S.p && S.phase !== "battle") {
      gToast("只有在战斗阶段才能发起攻击（先进主要阶段再进入战斗阶段）");
      return;
    }
    const isSword = !!atkUnit.isSword;
    const atkName = isSword ? "冠军之剑" : `「${atkUnit.card.name}」`;
    log(`${atkSide.name} 的 ${atkName} 宣告攻击 ${target === "player" ? "本体" : `「${target.card.name}」`}`);

    // 横置攻击者。冠军之剑是 side.sword 上的状态，不在临时对象上，
    // 必须写回 atkSide.sword，否则剑永远不会疲劳。
    const tapAttacker = () => {
      if (isSword) atkSide.sword.tapped = true;
      else atkUnit.tapped = true;
    };

    // 1) [响应]：对手可在自己回合外使用响应卡取消攻击
    if (await askResponse(defSide, atkUnit, atkSide)) {
      tapAttacker();
      log("攻击被[响应]打断，攻击者横置。");
      render();
      return;
    }

    // 2) 决定由谁接战（守护拦截）
    //    · 攻击目标本身就是「活跃的守护角色」→ 它直接接战，无需再询问守护
    //    · 冠军之剑：目标若是角色，该角色就是阻挡者（阻挡剑必死）
    let blocker = null;
    const targetIsGuardItself = target !== "player" && hasGuard(target) && !target.tapped;
    if (isSword && target !== "player") {
      blocker = target;
    } else if (!targetIsGuardItself) {
      blocker = await askGuard(defSide, atkUnit, target, atkSide);
    }

    tapAttacker();
    render();

    // 3) 冠军之剑：可以被阻挡，但阻挡者必死；无人拦截命中本体 → 直接获胜
    if (isSword) {
      if (blocker) {
        log(`「${blocker.card.name}」阻挡冠军之剑——阻挡者必死！`, "g-hot");
        destroy(blocker, defSide);
      } else {
        endGame(atkSide, "冠军之剑命中本体！");
      }
      render();
      return;
    }

    // 4) [攻击时] 触发（宣告攻击时，先于战力比大小）
    await fireTrigger(ON_ATTACK, atkUnit, {
      side: atkSide, unit: atkUnit, target, isAI: atkSide === S.a
    });

    // 5) 结算
    if (blocker) {
      await battle(atkUnit, atkSide, blocker, defSide, true);
      if (defSide.field.includes(blocker)) blocker.tapped = true;   // 守护后横置
    } else if (target === "player") {
      addResonance(atkSide, 1);   // 命中本体 +1 共鸣值
      fxAt(atkSide === S.p ? "z-res-a" : "z-res-p", "+1 共鸣", "res");
    } else {
      await battle(atkUnit, atkSide, target, defSide, false);
    }
    render();
  }

  // 战力比大小：赢家减去输家战力（本回合内），输家被击破；平点双方都被击破
  async function battle(atkUnit, atkSide, defUnit, defSide, isGuard) {
    if (isGuard) {
      await fireTrigger(ON_GUARD, defUnit, { side: defSide, unit: defUnit, isAI: defSide === S.a });
    }
    const ap = effPower(atkUnit);
    const dp = effPower(defUnit);
    fxLunge(atkUnit, atkSide === S.p ? 1 : -1);
    log(`⚔ 战斗结算：${ap} vs ${dp}`);

    if (ap > dp) {
      atkUnit.dmgTaken += dp;
      fxHit(defUnit);
      fx(defUnit, `-${dp}`, "dmg");
      destroy(defUnit, defSide);
      log(`「${atkUnit.card.name}」获胜，反伤：本回合战力变为 ${effPower(atkUnit)}（回合结束恢复）`);
      checkDestroy(atkUnit, atkSide);
    } else if (dp > ap) {
      defUnit.dmgTaken += ap;
      fxHit(atkUnit);
      fx(atkUnit, `-${ap}`, "dmg");
      destroy(atkUnit, atkSide);
      log(`「${defUnit.card.name}」获胜，反伤：本回合战力变为 ${effPower(defUnit)}`);
      checkDestroy(defUnit, defSide);
    } else {
      log(`平点（${ap} vs ${dp}）！双方同归于尽。`, "g-hot");
      destroy(defUnit, defSide);
      destroy(atkUnit, atkSide);
    }
  }

  // 按登记表触发某个时点的卡牌效果
  async function fireTrigger(table, unit, ctx) {
    const equip = unit.equipCard;
    // 装备卡自身的效果也要触发（如利贝拉 [攻击时]）
    if (equip && table[equip.id]) await table[equip.id]({ ...ctx, api: API, equip });
    if (unit.card && table[unit.card.id]) await table[unit.card.id]({ ...ctx, api: API });
  }

  // [响应]：对手使用「让人想要哭泣的场景」使攻击者疲劳，取消这次攻击
  async function askResponse(defSide, atkUnit, atkSide) {
    const idx = defSide.hand.findIndex(c => c.id === "card21");
    if (idx < 0 || !canPay(defSide, defSide.hand[idx])) return false;
    const card = defSide.hand[idx];

    if (defSide === S.a) {
      // AI：攻击者战力够大才值得交响应
      if (effPower(atkUnit) < 2500) return false;
      tryPay(defSide, card);
      defSide.hand.splice(idx, 1);
      defSide.discard.push(card);
      log("AI 使用[响应]「让人想要哭泣的场景」！");
      return true;
    }

    const use = await choose(
      `AI 的「${atkUnit.card.name}」宣告攻击！是否使用[响应]「让人想要哭泣的场景」（费用2·虚）使其横置、取消这次攻击？`,
      [{ label: "使用响应卡（支付 2 费·至少 1 张虚）", value: true }, { label: "不使用", value: false }]);
    if (!use) return false;
    if (!(await payFor(defSide, card, false))) return false;
    defSide.hand.splice(idx, 1);
    defSide.discard.push(card);
    log("你使用[响应]「让人想要哭泣的场景」！");
    return true;
  }

  // [守护]：一回合一次，守护后横置；疲劳状态无法阻挡（规则 6）
  async function askGuard(defSide, atkUnit, target, atkSide) {
    const guards = defSide.field.filter(u => hasGuard(u) && !u.tapped);
    if (!guards.length) return null;

    if (defSide === S.a) {
      if (atkUnit.isSword) return null;   // 挡剑必死，AI 不挡
      if (target !== "player") return null;
      const ap = effPower(atkUnit);
      const g = guards.find(u => effPower(u) > ap);
      if (g) { log(`AI 用「${g.card.name}」守护！`); return g; }
      return null;
    }

    const opts = guards.map(u => ({
      label: `「${u.card.name}」（战力 ${effPower(u)}）`,
      sub: "与攻击者比战力（含反伤），守护后横置；一回合只能守护一次",
      img: u.card.img,
      value: u
    }));
    opts.push({ label: "不守护，硬吃这次攻击", value: null });
    const atkLabel = atkUnit.isSword
      ? "冠军之剑（战力视为无限大 —— 阻挡者必死！）"
      : `「${atkUnit.card.name}」（战力 ${effPower(atkUnit)}）`;
    const g = await choose(
      `${atkSide.name} 的 ${atkLabel}攻击${target === "player" ? "你的本体" : `你的「${target.card.name}」`}——用谁守护？`,
      opts);
    if (g) log(`你用「${g.card.name}」守护！`);
    return g;
  }

  /* ============================================================
     八、出牌
     ============================================================ */

  function equipOk(u, card) {
    if (card.exclusiveTo) return u.card.name === card.exclusiveTo;
    return u.card.weapons.includes(card.weapons[0]) || u.card.keywords.includes("泛用");
  }

  async function playCard(side, card, isAI, presetTarget) {
    if (side === S.p && S.phase !== "main") {
      gToast("只有在主要阶段才能出牌（填能阶段请先拖入费用区或点「跳过填能」）");
      return false;
    }
    if (!(await payFor(side, card, isAI))) return false;
    side.hand.splice(side.hand.indexOf(card), 1);

    // 掌门陶禹：使用「神威门」卡牌时抽 1 张
    // 静态效果，检查的是「支付完成、卡牌尚未结算」这一刻已经在场的陶禹，
    // 故本次登场的陶禹自身不会触发自己（规则 7）
    if ((card.factions || []).includes("神威门")) {
      side.field.filter(u => u.card.id === "card03").forEach(() => {
        drawCards(side, 1);
        log(`${side.name}的「掌门陶禹」：使用「${card.name}」→ 抽 1 张`, "g-hot");
      });
    }

    const ctx = { side, card, unit: null, isAI, api: API, target: presetTarget };
    if (card.type === "角色") {
      const u = newUnit(card);
      side.field.push(u);
      ctx.unit = u;
      log(`${side.name} 登场「${card.name}」（战力 ${effPower(u)}，当回合不能攻击）`);
      fxShake(u.uid, "justDeploy");
      if (ON_ENTER[card.id]) await ON_ENTER[card.id](ctx);
    } else if (card.type === "装备") {
      await playEquip(side, card, isAI, presetTarget, ctx);
    } else if (card.type === "事件") {
      log(`${side.name} 使用事件「${card.name}」`);
      if (ON_EVENT[card.id]) await ON_EVENT[card.id](ctx);
      side.discard.push(card);
    }
    render();
    return true;
  }

  async function playEquip(side, card, isAI, presetTarget, ctx) {
    let bearer = presetTarget;
    if (!bearer) {
      const targets = side.field.filter(u => equipOk(u, card));
      if (!targets.length) {
        side.discard.push(card);
        log(`「${card.name}」没有可装备对象，进废弃区`);
        return;
      }
      bearer = await choose(`「${card.name}」装备给谁？`, targets.map(u => ({
        label: `「${u.card.name}」`,
        sub: `战力 ${effPower(u)} → ${effPower(u) + (card.power || 0) + (u.card.id === "card09" ? 500 : 0)}`,
        img: u.card.img,
        value: u
      })));
    }
    if (!bearer) { side.discard.push(card); return; }
    applyEquip(side, bearer, card);
  }

  function applyEquip(side, bearer, card) {
    bearer.equipCard = card;
    bearer.bonus += card.power || 0;
    // 装备时的静态加成（如蠢脸骑士 力量+500）
    if (ON_EQUIP[bearer.card.id]) ON_EQUIP[bearer.card.id]({ side, bearer, card, api: API });

    // [共鸣时]：专属武器装到专属角色身上的那一刻
    const resonates = card.exclusiveTo && bearer.card.name === card.exclusiveTo;
    if (resonates) {
      bearer.resonanceTurn = S.turnCount;   // 共鸣状态当回合即可攻击
      log(`⚡ 「${card.name}」×「${bearer.card.name}」共鸣！当回合即可攻击`, "g-hot");
      if (card.id === "card15") bearer.silenceEquip = true;
      if (ON_RESONATE[card.id]) ON_RESONATE[card.id]({ side, bearer, card, unit: bearer, api: API });
    }
    log(`${side.name} 装备「${card.name}」→「${bearer.card.name}」`);
    fx(bearer, `+${card.power || 0}`, "buff");
  }

  /* ============================================================
     九、对外 API（供卡牌行为处理器调用，避免处理器直接碰内部函数）
     ============================================================ */

  const API = {
    log,
    draw: drawCards,
    foe: opp,
    power: effPower,
    canAttack,
    turn: () => S.turnCount,
    choose,
    reveal: revealModal,
    arrange: arrangeModal,
    destroy,
    bounce,
    resonance: addResonance,
    checkDestroy,
    fx,
    fxAt,
    // 让玩家/AI 从己方角色里挑一个
    pickAlly: (others, isAI, title) => {
      if (isAI || window.GTCG_AUTO) return Promise.resolve([...others].sort((a, b) => effPower(b) - effPower(a))[0]);
      return choose(title, others.map(x => ({
        label: x.card.name, sub: `战力 ${effPower(x)}`, img: x.card.img, value: x
      })));
    }
  };

  /* ============================================================
     十、能量填充（规则 4）
     ============================================================ */

  function fillEnergy(side, card, silent) {
    if (side === S.p && !(S.active === S.p && S.phase === "fill")) {
      gToast("填能只能在填能阶段进行（一旦进入主要阶段，本回合不能再填能）");
      return false;
    }
    if (side.filledThisTurn) {
      gToast("本回合已经填过能量了（每回合最多 1 张）");
      return false;
    }
    side.hand.splice(side.hand.indexOf(card), 1);
    side.energy.push({ card, tapped: false });
    side.filledThisTurn = true;
    if (!silent) log(`${side.name} 将「${card.name}」填入能量区（本回合已填）`);
    // 玩家填能后自动进入下一个阶段（主要阶段）
    if (side === S.p && S.phase === "fill") {
      S.phase = "main";
      log("→ 填能完成，自动进入【主要阶段】可任意出牌", "g-turn");
    }
    render();
    return true;
  }

  /* ============================================================
     十一、回合与阶段状态机（规则 3）
     ============================================================ */

  async function startTurn(side) {
    S.turnCount++;
    side.turns++;
    S.active = side;
    S.phase = "draw";
    side.filledThisTurn = false;
    // 抽牌阶段：能量区全部解除横置（恢复）
    side.energy.forEach(e => e.tapped = false);
    side.field.forEach(u => { u.tapped = false; });
    if (side.sword.onField) side.sword.tapped = false;

    log(`—— ${side.name} 的回合（第 ${side.turns} 回合）——`, "g-turn");
    if (S.turnCount > 1) drawCards(side, 1);   // 先手第一回合不抽牌
    S.phase = "fill";
    if (side === S.p) log("【填能阶段】可拖 1 张手牌到费用区填入，或点右下按钮跳过填能直接进入主要阶段", "g-hot");
    render();
  }

  // 阶段推进表：把原先的 if/else 链改成「当前阶段 → 下一阶段」
  const PHASE_NEXT = {
    fill: async () => {
      if (!S.p.filledThisTurn) log("跳过填能阶段——本回合不能再填能量了");
      S.phase = "main";
      log("→ 进入【主要阶段】可任意出牌（费用够就能用）", "g-turn");
    },
    main: async () => {
      S.phase = "battle";
      log("→ 进入【战斗阶段】点选或拖动己方角色发起攻击", "g-turn");
    },
    battle: async () => { await endTurn(); }
  };

  async function nextPhase() {
    if (S.over || busy || S.active !== S.p) return;
    const step = PHASE_NEXT[S.phase];
    if (!step) return;
    await step();
    render();
  }

  async function endTurn() {
    if (S.over || S.active !== S.p) return;
    busy = true;
    cleanupTurnEnd(S.p);
    S.phase = "end";
    render();
    await sleep(500);
    await startTurn(S.a);
    if (S.over) { busy = false; return; }
    await aiTurn();
  }

  /* ============================================================
     十二、AI
     ============================================================ */

  function aiFillEnergy() {
    const s = S.a;
    if (s.filledThisTurn || !s.hand.length) return;
    // 优先把费用最高、且当前打不出的卡填进能量区
    const c = [...s.hand].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0];
    s.hand.splice(s.hand.indexOf(c), 1);
    s.energy.push({ card: c, tapped: false });
    s.filledThisTurn = true;
    log("AI 填 1 张能量");
  }

  // AI 是否该打这张牌：按类型分派
  function aiWantsCard(me, foe, c) {
    if (c.type === "角色") return true;
    if (c.type === "装备") return me.field.some(u => equipOk(u, c));
    if (c.type === "事件") {
      const rule = AI_WANTS[c.id];
      return rule ? rule(me, foe, API) : false;
    }
    return false;
  }

  async function aiMain() {
    const me = S.a, foe = S.p;
    let acted = true, guard = 0;
    while (acted && guard++ < 20) {
      acted = false;
      // 优先出高费牌，让每回合费用利用率更高
      const playable = me.hand.filter(c => canPay(me, c)).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
      for (const c of playable) {
        if (!aiWantsCard(me, foe, c)) continue;
        const bearer = c.type === "装备" ? me.field.find(u => equipOk(u, c)) : undefined;
        await playCard(me, c, true, bearer);
        acted = true;
        break;
      }
    }
  }

  async function aiBattle() {
    const me = S.a, foe = S.p;
    for (const u of [...me.field]) {
      if (S.over) return;
      if (!canAttack(u) || u.tapped) continue;
      const ap = effPower(u);
      // 优先打能赢的疲劳角色，否则打本体
      const winnable = attackableTargets(u, foe).filter(t => ap > effPower(t));
      const target = winnable.length
        ? winnable.sort((a, b) => effPower(b) - effPower(a))[0]
        : "player";
      await declareAttack(me, foe, u, target);
      if (S.over) return;
      await sleep(500);
    }
    if (!S.over && swordCanAttack(me)) {
      await declareAttack(me, foe, { isSword: true, card: SWORD, uid: "sword" }, "player");
    }
  }

  async function aiTurn() {
    if (S.over) { busy = false; return; }
    await sleep(600);
    S.phase = "fill"; render();
    aiFillEnergy(); render();
    await sleep(600);
    S.phase = "main"; render();
    await aiMain();
    if (S.over) { busy = false; return; }
    await sleep(500);
    S.phase = "battle"; render();
    await aiBattle();
    if (S.over) { busy = false; return; }
    await sleep(400);
    cleanupTurnEnd(S.a);
    await startTurn(S.p);
    busy = false;
    render();
  }

  /* ============================================================
     十三、开局：掷骰定先手 + 对局准备（规则 2）
     ============================================================ */

  function dieHtml(v) {
    const pips = DIE_PIPS[v] || [];
    return `<div class="die">` +
      Array.from({ length: 9 }, (_, i) => `<i class="${pips.indexOf(i) >= 0 ? "on" : ""}"></i>`).join("") +
      `</div>`;
  }

  // 掷骰：双方各一颗，点数大者先手（平局重掷）
  function rollDice(force) {
    const rnd = () => 1 + Math.floor(Math.random() * 6);
    let p, a;
    if (force === "p") { p = 6; a = 1 + Math.floor(Math.random() * 5); }
    else if (force === "a") { a = 6; p = 1 + Math.floor(Math.random() * 5); }
    else { do { p = rnd(); a = rnd(); } while (p === a); }
    return { p, a, first: p > a ? "p" : "a" };
  }

  function diceModal(res) {
    if (window.GTCG_AUTO) return Promise.resolve();
    return new Promise(resolve => {
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      mask.innerHTML = `<div class="modal col dice-modal">
        <h2 style="font-size:20px;color:#fff">🎲 掷骰定先手</h2>
        <div class="g-pay-sub">双方各掷一颗骰子，点数大的一方先手；<b>先手第一回合不抽牌</b>，后手第一回合抽 1 张。</div>
        <div class="dice-row">
          <div class="dice-side"><div class="dice-who">你</div><div id="die-p">${dieHtml(res.p)}</div></div>
          <div class="dice-vs">VS</div>
          <div class="dice-side"><div class="dice-who">AI</div><div id="die-a">${dieHtml(res.a)}</div></div>
        </div>
        <div class="dice-result" id="dice-result">掷骰中…</div>
        <div class="g-pay-foot"><span class="g-pay-count" id="dice-count">…</span><button class="btn primary" id="dice-ok" disabled>开始对局</button></div>
      </div>`;
      document.body.appendChild(mask);
      const dp = mask.querySelector("#die-p"), da = mask.querySelector("#die-a");
      const resultEl = mask.querySelector("#dice-result");
      const okBtn = mask.querySelector("#dice-ok"), cntEl = mask.querySelector("#dice-count");
      const spin = setInterval(() => {
        dp.innerHTML = dieHtml(1 + Math.floor(Math.random() * 6));
        da.innerHTML = dieHtml(1 + Math.floor(Math.random() * 6));
      }, 70);
      setTimeout(() => {
        clearInterval(spin);
        dp.innerHTML = dieHtml(res.p);
        da.innerHTML = dieHtml(res.a);
        const youWin = res.first === "p";
        resultEl.innerHTML = `你 <b class="${youWin ? "win" : ""}">${res.p}</b> : <b class="${youWin ? "" : "win"}">${res.a}</b> AI —— <span class="${youWin ? "win" : "lose"}">${youWin ? "你先手！" : "AI 先手"}</span>`;
        cntEl.textContent = youWin ? "你执先手 · 第一回合不抽牌" : "AI 执先手 · 你第一回合抽 1 张";
        okBtn.disabled = false;
        okBtn.addEventListener("click", () => { mask.remove(); resolve(); });
      }, window.GTCG_FAST ? 5 : 900);
    });
  }

  // 对局准备：双方各自从手牌选 1 张填入能量区（无种类限制，以活跃状态入区）
  async function prepareEnergy() {
    // 玩家：手牌里点 1 张
    const card = await new Promise(res => {
      if (window.GTCG_AUTO) return res(S.p.hand[0]);
      const mask = document.createElement("div");
      mask.className = "modal-mask open";
      mask.innerHTML = `<div class="modal col" style="max-width:680px">
        <h2 style="font-size:19px;margin-bottom:6px;color:#fff">对局准备 · 选择 1 张填入能量区</h2>
        <div class="g-pay-sub">双方各自从手牌选 <b>1</b> 张填入能量区（无种类限制，以<b>活跃</b>状态入区）。<br>
          这张牌不消耗费用，是本局的起手能量来源。</div>
        <div class="g-reveal-grid">${S.p.hand.map((c, i) =>
          `<div class="g-reveal-card pickable" data-i="${i}"><img src="${c.img}"><div class="g-reveal-name">${c.name}</div>
           <div class="g-reveal-tag">${c.attr}·费${c.cost ?? "-"}</div></div>`
        ).join("")}</div>
        <div class="g-pay-foot"><span class="g-pay-count">点选 1 张作为起手能量</span></div>
      </div>`;
      document.body.appendChild(mask);
      mask.querySelectorAll(".g-reveal-card").forEach(el => {
        el.addEventListener("click", () => {
          const c = S.p.hand[+el.dataset.i];
          mask.remove();
          res(c);
        });
      });
    });
    if (card) {
      S.p.hand.splice(S.p.hand.indexOf(card), 1);
      S.p.energy.push({ card, tapped: false });
      log(`你从手牌选「${card.name}」填入能量区（活跃入区）`, "g-hot");
    }
    // AI：选费用最高的（保证后续回合有费可用）
    if (S.a.hand.length) {
      const c = [...S.a.hand].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0];
      S.a.hand.splice(S.a.hand.indexOf(c), 1);
      S.a.energy.push({ card: c, tapped: false });
      log("AI 从手牌选 1 张填入能量区");
    }
    render();
  }

  async function startBattle(force) {
    if (!S || S.started || S.over || busy) return false;
    busy = true;
    render();
    const res = rollDice(force);
    await diceModal(res);
    S.started = true;
    S.firstSide = res.first;
    log(`🎲 掷骰：你 ${res.p} 点，AI ${res.a} 点 —— ${res.first === "p" ? "你" : "AI"}先手（先手第一回合不抽牌）。`, "g-hot");
    render();
    await prepareEnergy();   // 规则 2：双方各填 1 张开局能量

    const first = res.first === "p" ? S.p : S.a;
    await startTurn(first);
    if (res.first === "p") {
      busy = false;
      render();
    } else {
      await aiTurn();   // aiTurn 结束时会把 busy 复位
    }
    return true;
  }

  function endGame(winner, reason) {
    S.over = true;
    busy = false;
    log(`🏆 ${winner.name} 获胜！${reason}`, "g-hot");
    const lbl = $("g-turn-label");
    if (lbl) lbl.innerHTML = `<span style="color:var(--gold);font-size:20px;font-weight:800">🏆 ${winner.name} 获胜！${reason}</span>`;
    const btn = $("g-end");
    if (btn) btn.disabled = true;
  }

  /* ============================================================
     十四、渲染（增量更新：不重建已存在的卡图，避免整场闪屏）
     ============================================================ */

  const memoHTML = {};
  const clearMemo = () => { for (const k in memoHTML) delete memoHTML[k]; };

  function setHTML(id, html) {
    const el = $(id);
    if (!el || memoHTML[id] === html) return;
    el.innerHTML = html;
    memoHTML[id] = html;
  }

  // 牌库/废弃区：图片与数字分别增量更新（抽牌只改数字，不重建卡图）
  function setPile(id, src, num, emptyLabel) {
    const box = $(id);
    if (!box) return;
    let img = box.querySelector("img.g-pile-img");
    let label = box.querySelector("div.g-zone-empty");
    if (src) {
      if (label) label.remove();
      if (!img) {
        img = document.createElement("img");
        img.className = "g-pile-img";
        box.insertBefore(img, box.firstChild);
      }
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    } else {
      if (img) img.remove();
      if (!label) {
        label = document.createElement("div");
        label.className = "g-zone-empty";
        box.insertBefore(label, box.firstChild);
        label.textContent = emptyLabel;
      } else if (label.textContent !== emptyLabel) label.textContent = emptyLabel;
    }
    let numEl = box.querySelector("div.g-pile-num");
    if (!numEl) {
      numEl = document.createElement("div");
      numEl.className = "g-pile-num";
      box.appendChild(numEl);
    }
    if (numEl.textContent !== String(num)) numEl.textContent = num;
  }

  // 键控同步：按 key 复用已有 DOM，只增删变化的那几张（已存在的卡图不会被重建 → 不闪）
  function syncKeyed(id, items, emptyHtml) {
    const box = $(id);
    if (!box) return;
    const keep = new Set(items.map(i => i.key));
    [...box.children].forEach(ch => { if (ch.dataset.key && !keep.has(ch.dataset.key)) ch.remove(); });
    const byKey = new Map();
    [...box.children].forEach(ch => { if (ch.dataset.key) byKey.set(ch.dataset.key, ch); });
    let prev = null;
    items.forEach(it => {
      let el = byKey.get(it.key);
      if (!el) {
        const tpl = document.createElement("template");
        tpl.innerHTML = it.html.trim();
        el = tpl.content.firstElementChild;
        el.dataset.key = it.key;
        el.dataset.sig = it.sig;
        box.insertBefore(el, prev ? prev.nextSibling : box.firstChild);
        if (it.bind) it.bind(el);
      } else {
        if (el.className !== it.cls) el.className = it.cls;
        if (el.dataset.sig !== it.sig) { el.innerHTML = it.inner; el.dataset.sig = it.sig; }
        if (it.attrs) for (const k in it.attrs) if (el.getAttribute(k) !== it.attrs[k]) el.setAttribute(k, it.attrs[k]);
        const want = prev ? prev.nextSibling : box.firstChild;
        if (want !== el) box.insertBefore(el, want);
      }
      prev = el;
    });
    const ph = box.querySelector(".g-zone-empty");
    if (!items.length) { if (!ph) box.innerHTML = emptyHtml; }
    else if (ph) ph.remove();
  }

  // 能量区等纯 img 区域
  function syncCards(id, list, emptyHtml) {
    const box = $(id);
    if (!box) return;
    const keep = new Set(list.map(i => i.key));
    [...box.children].forEach(ch => { if (ch.dataset.key && !keep.has(ch.dataset.key)) ch.remove(); });
    const byKey = new Map();
    [...box.children].forEach(ch => { if (ch.dataset.key) byKey.set(ch.dataset.key, ch); });
    let prev = null;
    list.forEach(it => {
      let el = byKey.get(it.key);
      if (!el) {
        el = document.createElement("img");
        el.dataset.key = it.key;
        box.insertBefore(el, prev ? prev.nextSibling : box.firstChild);
      } else {
        const want = prev ? prev.nextSibling : box.firstChild;
        if (want !== el) box.insertBefore(el, want);
      }
      if (el.getAttribute("src") !== it.src) el.setAttribute("src", it.src);
      if (el.className !== it.cls) el.className = it.cls;
      if (el.title !== it.title) el.title = it.title;
      prev = el;
    });
    const ph = box.querySelector(".g-zone-empty");
    if (!list.length) { if (!ph) box.innerHTML = emptyHtml; }
    else if (ph) ph.remove();
  }

  // 单位卡的可见状态徽章（关键词 / 临时状态）
  function unitBadges(u) {
    const b = [];
    if (hasGuard(u)) b.push({ t: "守", cls: "bd-guard", tip: "守护" });
    if (hasRaid(u)) b.push({ t: "突", cls: "bd-raid", tip: "突袭" });
    if (u.cannotAttack) b.push({ t: "禁", cls: "bd-noatk", tip: "不能攻击" });
    if (u.resonanceTurn === S.turnCount) b.push({ t: "共", cls: "bd-reso", tip: "共鸣（当回合可攻击）" });
    if (u.equipCard) b.push({ t: "武", cls: "bd-equip", tip: `装备：${u.equipCard.name}` });
    return b;
  }

  // 单位卡 HTML：卡图 + 名字 + 战力角标 + 关键词徽章（KADMIN 风格的信息密度）
  function unitItem(u, mine) {
    const p = effPower(u);
    const badges = unitBadges(u);
    const canAtk = mine && S.active === S.p && S.phase === "battle" && !S.over && !busy && canAttack(u);
    const cls = [
      "g-unit",
      u.tapped ? "tapped" : "",
      canAtk ? "atk-ok" : "",
      u.equipCard ? "has-equip" : "",
      p > (u.card.power || 0) ? "buffed" : (p < (u.card.power || 0) ? "hurt" : "")
    ].filter(Boolean).join(" ");
    const tip = [
      u.card.name,
      `战力 ${p}${p !== (u.card.power || 0) ? `（原 ${u.card.power || 0}）` : ""}`,
      u.tapped ? "疲劳（横置）" : "活跃",
      u.equipCard ? `装备：${u.equipCard.name}` : "",
      u.dmgTaken > 0 ? `反伤 -${u.dmgTaken}（回合结束恢复）` : "",
      u.tmpBuff ? `本回合 ${u.tmpBuff > 0 ? "+" : ""}${u.tmpBuff}` : ""
    ].filter(Boolean).join(" · ");
    const inner =
      `<img src="${u.card.img}" class="g-unit-img" alt="">` +
      `<div class="g-unit-name">${u.card.name}</div>` +
      `<div class="g-unit-pow">${p}</div>` +
      (badges.length
        ? `<div class="g-unit-badges">${badges.map(b => `<i class="${b.cls}" title="${b.tip}">${b.t}</i>`).join("")}</div>`
        : "");
    return {
      key: u.uid,
      cls,
      inner,
      sig: `${p}|${u.tapped}|${badges.map(b => b.t).join("")}|${u.equipCard ? u.equipCard.id : ""}`,
      html: `<div class="${cls}" data-uid="${u.uid}" title="${tip}">${inner}</div>`
    };
  }

  function swordItem(who) {
    const sw = who === "p" ? S.p.sword : S.a.sword;
    const canAtk = who === "p" && sw.onField && swordCanAttack(S.p) &&
                   S.active === S.p && S.phase === "battle" && !busy && !S.over;
    const cls = `g-sword-field${sw.tapped ? " tapped" : ""}${canAtk ? " atk-ok" : ""}`;
    const inner = `<img src="${SWORD.img}" alt=""><div class="g-unit-name">冠军之剑</div><div class="g-unit-pow">∞</div>`;
    return {
      key: "sword-" + who, cls, inner, sig: "sword",
      html: `<div class="${cls}" data-uid="sword-${who}" title="冠军之剑 · 战力视为无限大，命中本体直接获胜">${inner}</div>`,
      bind: who === "p" ? bindSword : null
    };
  }

  // 战场单位宽度上限：高度由 CSS 撑满战场区（不依赖 JS 测量时机），
  // JS 只需要保证「一行放得下场上最多的那一方」，把宽度上限写进 --unit-max-w。
  function fitUnits() {
    const zones = [$("z-field-p"), $("z-field-a")];
    const z = zones.find(el => el && el.clientWidth > 0);
    if (!z) return;
    const counts = [S.p.field.length + (S.p.sword.onField ? 1 : 0),
                    S.a.field.length + (S.a.sword.onField ? 1 : 0)];
    const maxN = Math.max(1, ...counts);
    const styles = getComputedStyle(z);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const gap = parseFloat(styles.gap) || 8;
    // 一行放下 maxN 张时的单卡最大宽度（留 4px 吸收亚像素误差）
    const w = Math.max(30, Math.floor((z.clientWidth - padX - (maxN - 1) * gap - 4) / maxN));
    if (w !== fitUnits._last) {
      fitUnits._last = w;
      document.documentElement.style.setProperty("--unit-max-w", w + "px");
    }
  }

  // 安全写文本：元素可能不存在（新版布局删掉了旧侧栏），缺了就静默跳过
  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== String(text)) el.textContent = text;
  }

  function render() {
    if (!S) return;
    fitUnits();
    setText("res-p", S.p.resonance);
    setText("res-a", S.a.resonance);
    const bp = $("res-bar-p"), ba = $("res-bar-a");
    if (bp) bp.style.width = (S.p.resonance / RESONANCE_MAX * 100) + "%";
    if (ba) ba.style.width = (S.a.resonance / RESONANCE_MAX * 100) + "%";
    if (!S.over) {
      setText("g-turn-label", !S.started
        ? "点【开始战斗】掷骰定先手"
        : (S.active === S.p ? "▶ 你的回合" : "▶ AI 行动中…"));
    }
    setText("turn-num", S.started ? `第 ${S.turnCount} 回合` : "准备战斗");

    // 阶段指示 + 阶段按钮
    const curIdx = S.phase === "end" ? PHASE_ORDER.length : PHASE_ORDER.indexOf(S.phase);
    setText("g-cur-phase", PHASE_NAME[S.phase] || "—");
    document.querySelectorAll("#g-phases span").forEach(el => {
      const i = PHASE_ORDER.indexOf(el.dataset.ph);
      el.classList.toggle("done", i >= 0 && i < curIdx);
      el.classList.toggle("on", el.dataset.ph === S.phase);
    });

    const endBtn = $("g-end");
    if (endBtn) {
      const label =
        S.over ? "对局已结束" :
        !S.started ? "点【开始战斗】开局" :
        S.active !== S.p ? "AI 行动中…" :
        busy ? "请稍候…" :
        PHASE_BUTTON[S.phase] || "…";
      endBtn.disabled = S.over || !S.started || S.active !== S.p || busy;
      endBtn.textContent = label;
    }

    // 开局遮罩
    const ov = $("g-start");
    if (ov) {
      ov.classList.toggle("hide", !!S.started);
      const sub = $("g-start-sub");
      if (sub) sub.textContent = `${S.p.deckName}　VS　${S.a.deckName}　·　起手各 ${HAND_START} 张`;
    }

    // 顶栏：我的信息
    setText("my-deck-name", S.p.deckName);
    setText("my-hand-num", S.p.hand.length);
    setText("my-energy-num", `${S.p.energy.filter(e => !e.tapped).length}/${S.p.energy.length}`);
    setText("my-fill-state", S.p.filledThisTurn
      ? "已填能"
      : (S.active === S.p && S.phase === "fill" ? "可填 1 张" : "未填"));

    // 抽屉：AI 信息
    setText("ai-deck-name", S.a.deckName);
    setText("ai-deck-name2", S.a.deckName);
    setText("ai-res-num", S.a.resonance);
    $("ai-hand-num").textContent = S.a.hand.length;
    setText("ai-deck-num", S.a.deck.length);
    setText("ai-discard-num", S.a.discard.length);
    setText("ai-energy-num", `${S.a.energy.filter(e => !e.tapped).length}/${S.a.energy.length}`);
    setText("ai-sword-state", S.a.sword.onField ? "已入场战场！" : `EX 待命（${S.a.resonance}/${RESONANCE_MAX}）`);

    // 牌库 / 废弃区
    setPile("z-deck", "assets/cardback.png", S.p.deck.length, "");
    const topDiscard = S.p.discard[S.p.discard.length - 1];
    setPile("z-discard", topDiscard ? topDiscard.img : null, S.p.discard.length, "废弃区");
    setPile("z-deck-a", "assets/cardback.png", S.a.deck.length, "");
    const topDiscardA = S.a.discard[S.a.discard.length - 1];
    setPile("z-discard-a", topDiscardA ? topDiscardA.img : null, S.a.discard.length, "废弃区");

    // EX ZONE：冠军之剑开局放置于此，满 12 共鸣移至战场
    setHTML("z-ex", S.p.sword.onField
      ? `<div class="g-zone-empty">EX ZONE</div>`
      : `<img src="${SWORD.img}" class="g-ex-sword" title="你的冠军之剑——共鸣 ${S.p.resonance}/${RESONANCE_MAX}，满 ${RESONANCE_MAX} 移至战场">`);
    setHTML("z-ex-a", S.a.sword.onField
      ? `<div class="g-zone-empty">EX ZONE</div>`
      : `<img src="${SWORD.img}" class="g-ex-sword" title="AI 的冠军之剑——共鸣 ${S.a.resonance}/${RESONANCE_MAX}，满 ${RESONANCE_MAX} 移至战场">`);

    // 能量区
    const energyItems = (side, mine) => side.energy.map((e, i) => ({
      key: "e" + i,
      src: e.card.img,
      cls: "g-energy" + (e.tapped ? " tapped" : ""),
      title: `${mine ? "" : "AI："}${e.card.name}·${e.card.attr}${e.tapped ? "（已横置）" : ""}`
    }));
    syncCards("z-energy", energyItems(S.p, true), `<div class="g-zone-empty">你的费用区（填能阶段拖入手牌填入）</div>`);
    syncCards("z-energy-a", energyItems(S.a, false), `<div class="g-zone-empty">AI 费用区</div>`);

    // 场上
    const itemsA = S.a.field.map(u => { const it = unitItem(u, false); it.bind = bindEnemyUnit; return it; });
    if (S.a.sword.onField) itemsA.push(swordItem("a"));
    syncKeyed("z-field-a", itemsA, `<div class="g-zone-empty">AI 战场</div>`);

    const itemsP = S.p.field.map(u => { const it = unitItem(u, true); it.bind = bindMineUnit; return it; });
    if (S.p.sword.onField) itemsP.push(swordItem("p"));
    syncKeyed("z-field-p", itemsP, `<div class="g-zone-empty">你的战场（主要阶段拖角色卡上场）</div>`);

    // 手牌
    const seen = {};
    syncKeyed("g-hand", S.p.hand.map((c, i) => {
      const n = (seen[c.id] = (seen[c.id] || 0) + 1);
      const myTurn = S.active === S.p && !S.over && !busy;
      const playable = myTurn && S.phase === "main" && canPay(S.p, c);
      const fillable = myTurn && S.phase === "fill" && !S.p.filledThisTurn;
      const cls = `g-handcard${playable ? " playable" : ""}${fillable ? " fillable" : ""}`;
      const inner = `<img src="${c.img}" title="${c.name}｜${c.type}·费用${c.cost ?? "-"}·${c.attr}${c.power != null ? "·战力" + c.power : ""}（主要阶段拖到自己半场打出 / 填能阶段拖到费用区填能量）">`;
      return {
        key: `${c.id}#${n}`, sig: c.id, inner, cls,
        attrs: { "data-i": String(i) },
        bind: bindHandCard,
        html: `<div class="${cls}" data-i="${i}" draggable="true">${inner}</div>`
      };
    }), `<div class="g-zone-empty" style="align-self:center">手牌为空</div>`);

    bindStatic();
    syncFillZone();
  }

  /* ============================================================
     十五、交互
     ============================================================ */

  // 前场填能区可见性：填能阶段且本回合还没填过时亮出
  function syncFillZone() {
    const fz = $("g-fillzone");
    if (!fz) return;
    const show = S.started && !S.over && !busy &&
                 S.active === S.p && S.phase === "fill" && !S.p.filledThisTurn;
    fz.classList.toggle("show", show);
  }

  function startCardDrag(c) {
    dragCard = c;
    // 手牌是悬浮覆盖层：拖拽时让它退出命中测试，否则落点会被手牌挡住
    document.body.classList.add("dragging-card");
    const m = $("g-mat");
    if (S.phase === "main") m.classList.add("half-dragging");
    else if (S.phase === "fill" && !S.p.filledThisTurn) m.classList.add("energy-dragging");
    syncFillZone();
  }

  function startUnitDrag(u) {
    dragUnit = u;
    $("g-mat").classList.add("unit-dragging");
    markTargets(u);
  }

  function endDrag() {
    dragCard = null;
    dragUnit = null;
    $("g-mat").classList.remove("half-dragging", "drop-ok", "energy-dragging", "unit-dragging", "body-ok");
    clearTargets();
    document.body.classList.remove("g-touch-dragging", "dragging-card");
    syncFillZone();
  }

  const clearTargets = () => document.querySelectorAll(".atk-target").forEach(x => x.classList.remove("atk-target"));
  function markTargets(u) {
    clearTargets();
    $("z-field-a").querySelectorAll(".g-unit").forEach(el => {
      const t = S.a.field.find(x => x.uid === el.dataset.uid);
      if (t && attackableTargets(u, S.a).includes(t)) el.classList.add("atk-target");
    });
  }

  // 玩家发起一次攻击的公共入口（点击与拖拽共用）
  async function playerAttack(unit, target) {
    busy = true;
    render();
    await declareAttack(S.p, S.a, unit, target);
    busy = false;
    render();
  }

  // 点击单位 → 弹出攻击目标菜单
  async function attackMenu(u) {
    const opts = [{ label: "直接攻击对方本体", sub: "命中 +1 共鸣值", value: "player" }];
    attackableTargets(u, S.a).forEach(t => {
      const raid = hasRaid(u) && !t.tapped;
      opts.push({
        label: `${raid ? "[突袭] " : ""}攻击「${t.card.name}」（${t.tapped ? "疲劳" : "活跃"}·战力 ${effPower(t)}）`,
        sub: `你的战力 ${effPower(u)}，含反伤`,
        img: t.card.img,
        value: t
      });
    });
    const t = await choose(`「${u.card.name}」（战力 ${effPower(u)}）攻击目标？`, opts);
    if (t === null || t === undefined) return;
    await playerAttack(u, t);
  }

  function bindHandCard(el) {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener("dragstart", e => {
      const c = S.p.hand[+el.dataset.i];
      if (!c) { e.preventDefault(); return; }
      startCardDrag(c);
      e.dataTransfer.setData("text/plain", String(el.dataset.i));
      e.dataTransfer.effectAllowed = "copyMove";
    });
    el.addEventListener("dragend", () => endDrag());
    // 桌面：单击手牌 = 直接尝试打出 / 填能（不必拖拽）。
    // 之前只有移动端 pointerdown 旁路会弹菜单，桌面点一下毫无反应 —— 这是「牌下不了」的主因。
    el.addEventListener("click", e => {
      if (e.detail > 1) return;          // 双击不重复处理
      if (busy || S.over || S.active !== S.p || !S.started) return;
      const c = S.p.hand[+el.dataset.i];
      if (c) handCardMenu(c);
    });
    // 移动端：触摸拖拽旁路（鼠标仍走上面的 HTML5 DnD）
    el.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" || S.over || busy) return;
      tdDown(e, "card", S.p.hand[+el.dataset.i] || null, el);
    });
  }

  function bindMineUnit(el) {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener("dragstart", e => {
      const u = S.p.field.find(x => x.uid === el.dataset.uid);
      if (!u || busy || S.over || S.active !== S.p || S.phase !== "battle" || !canAttack(u)) {
        e.preventDefault();
        return;
      }
      startUnitDrag(u);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "unit:" + u.uid);
    });
    el.addEventListener("dragend", () => endDrag());

    // 装备卡拖到角色身上
    el.ondragover = e => {
      if (dragCard && dragCard.type === "装备" && S.phase === "main" && S.active === S.p && !busy && !S.over) {
        e.preventDefault();
        el.classList.add("drag-over");
      }
    };
    el.ondragleave = () => el.classList.remove("drag-over");
    el.ondrop = async e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");
      if (busy || S.over || S.active !== S.p || !dragCard) return;
      const u = S.p.field.find(x => x.uid === el.dataset.uid);
      const c = dragCard;
      dragCard = null;
      if (!u || c.type !== "装备") return;
      if (S.phase !== "main") { gToast("装备只能在主要阶段进行"); return; }
      if (!equipOk(u, c)) { gToast("武器类型 / 专属不匹配"); return; }
      if (!canPay(S.p, c)) { gToast("费用不足或没有对应属性的能量"); return; }
      busy = true;
      render();
      await playCard(S.p, c, false, u);
      busy = false;
      render();
    };

    // 点击 → 战斗阶段弹出攻击目标；否则显示详情
    el.addEventListener("click", async () => {
      const u = S.p.field.find(x => x.uid === el.dataset.uid);
      if (!u || busy || S.over || S.active !== S.p) return;
      if (S.phase === "battle" && canAttack(u)) await attackMenu(u);
      else showUnitInfo(u);
    });

    el.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" || S.over || busy) return;
      const u = S.p.field.find(x => x.uid === el.dataset.uid);
      tdDown(e, "unit", u || null, el);
    });
  }

  function bindEnemyUnit(el) {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.ondragover = e => {
      if (dragUnit && S.phase === "battle") { e.preventDefault(); el.classList.add("drag-over"); }
    };
    el.ondragleave = () => el.classList.remove("drag-over");
    el.ondrop = async e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");
      if (!dragUnit || busy || S.over || S.active !== S.p || S.phase !== "battle") return;
      const t = S.a.field.find(x => x.uid === el.dataset.uid);
      const u = dragUnit;
      dragUnit = null;
      if (!t) return;
      if (!attackableTargets(u, S.a).includes(t)) {
        gToast("只能攻击疲劳（横置）的角色——[突袭] 才能打活跃角色");
        return;
      }
      await playerAttack(u, t);
    };
    el.addEventListener("click", () => {
      const t = S.a.field.find(x => x.uid === el.dataset.uid);
      if (t && !busy) showUnitInfo(t);
    });
  }

  function bindSword(el) {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener("click", async () => {
      if (busy || S.over || S.active !== S.p || S.phase !== "battle" || !swordCanAttack(S.p)) return;
      await playerAttack({ isSword: true, card: SWORD, uid: "sword-p" }, "player");
    });
  }

  // 单位详情（点击非战斗状态时显示）
  function showUnitInfo(u) {
    const p = effPower(u);
    const badges = unitBadges(u);
    gToast(`「${u.card.name}」战力 ${p}${u.tapped ? " · 疲劳" : " · 活跃"}` +
      (badges.length ? " · " + badges.map(b => b.tip).join(" · ") : ""));
  }

  // 每帧刷新的部分（属性赋值幂等，不会累积监听）
  function bindStatic() {
    const mat = $("g-mat");
    const halfOf = e => {
      // 新版棋盘是「上=AI / 下=你」的纵向分区，以中线元素的实际位置为界
      const mid = document.querySelector(".g-midline");
      const r = (mid || mat).getBoundingClientRect();
      return e.clientY > r.top + r.height / 2 ? "p" : "a";
    };

    mat.ondragover = e => {
      if (dragUnit) {
        const bodyOk = S.phase === "battle" && halfOf(e) === "a";
        mat.classList.toggle("body-ok", bodyOk);
        if (bodyOk) e.preventDefault();
        return;
      }
      if (!dragCard) return;
      if (S.phase !== "main") { mat.classList.remove("drop-ok"); return; }
      const mine = halfOf(e) === "p";
      mat.classList.toggle("drop-ok", mine);
      if (mine) e.preventDefault();
    };
    mat.ondragleave = e => {
      if (e.target === mat) mat.classList.remove("drop-ok", "body-ok");
    };
    mat.ondrop = async e => {
      e.preventDefault();
      mat.classList.remove("drop-ok", "body-ok");
      if (busy || S.over || S.active !== S.p) return;
      const mine = halfOf(e) === "p";

      // 拖动己方单位 → 攻击对方本体
      if (dragUnit) {
        const u = dragUnit;
        dragUnit = null;
        if (mine) { gToast("攻击本体请拖到对面的半场（上半场）"); return; }
        if (S.phase !== "battle") { gToast("只能在战斗阶段攻击：请先点「进入战斗阶段」"); return; }
        await playerAttack(u, "player");
        return;
      }
      if (!dragCard) return;
      if (!mine) { gToast("要拖到你自己的半场（下半场）"); return; }
      if (S.phase !== "main") {
        gToast("出牌只能在主要阶段：填能阶段请拖到费用区，或点按钮进入主要阶段");
        dragCard = null;
        return;
      }
      const c = dragCard;
      dragCard = null;
      if (c.type === "装备") { gToast("装备卡请拖到具体的角色身上"); return; }
      if (c.type !== "角色" && c.type !== "事件") { gToast("这张卡不能直接上场"); return; }
      if (!canPay(S.p, c)) { gToast("费用不足或没有对应属性的能量"); return; }
      busy = true;
      render();
      await playCard(S.p, c, false);
      busy = false;
      render();
    };

    // 能量区 drop（仅填能阶段）
    const ze = $("z-energy");
    const canFill = () => dragCard && S.active === S.p && S.phase === "fill" &&
                          !S.p.filledThisTurn && !S.over && !busy;
    ze.ondragover = e => { if (canFill()) { e.preventDefault(); ze.classList.add("drag-over"); } };
    ze.ondragleave = () => ze.classList.remove("drag-over");
    ze.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      ze.classList.remove("drag-over");
      if (busy || S.over || S.active !== S.p || !dragCard) return;
      if (S.phase !== "fill") { gToast("填能只能在填能阶段进行（本回合已过填能阶段）"); dragCard = null; return; }
      if (S.p.filledThisTurn) { gToast("每回合最多填 1 张能量"); dragCard = null; return; }
      const c = dragCard;
      dragCard = null;
      fillEnergy(S.p, c);
    };

    // 前场填能区 drop（费用区被手牌悬浮层压住时的可见落点）
    const fz = $("g-fillzone");
    if (fz) {
      fz.ondragover = e => { if (canFill()) { e.preventDefault(); fz.classList.add("drag-over"); } };
      fz.ondragleave = () => fz.classList.remove("drag-over");
      fz.ondrop = e => {
        e.preventDefault();
        e.stopPropagation();
        fz.classList.remove("drag-over");
        if (busy || S.over || S.active !== S.p || !dragCard) return;
        if (S.phase !== "fill") { gToast("填能只能在填能阶段进行"); dragCard = null; return; }
        if (S.p.filledThisTurn) { gToast("每回合最多填 1 张能量"); dragCard = null; return; }
        const c = dragCard;
        dragCard = null;
        fillEnergy(S.p, c);
      };
    }

    // 玩家场上 drop（角色上场 / 事件结算）
    const fp = $("z-field-p");
    fp.ondragover = e => {
      if (dragCard && S.active === S.p && S.phase === "main" && !S.over && !busy) {
        e.preventDefault();
        fp.classList.add("drag-over");
      }
    };
    fp.ondragleave = () => fp.classList.remove("drag-over");
    fp.ondrop = async e => {
      e.preventDefault();
      e.stopPropagation();
      fp.classList.remove("drag-over");
      if (busy || S.over || S.active !== S.p || !dragCard) return;
      if (S.phase !== "main") { gToast("出牌只能在主要阶段进行"); dragCard = null; return; }
      const c = dragCard;
      dragCard = null;
      if (c.type === "装备") { gToast("装备卡请拖到具体的角色身上"); return; }
      if (c.type !== "角色" && c.type !== "事件") return;
      if (!canPay(S.p, c)) { gToast("费用不足或没有对应属性的能量"); return; }
      busy = true;
      render();
      await playCard(S.p, c, false);
      busy = false;
      render();
    };

    // 可攻击的单位才可拖动
    fp.querySelectorAll(".g-unit").forEach(el => {
      const u = S.p.field.find(x => x.uid === el.dataset.uid);
      const ok = !!u && S.active === S.p && S.phase === "battle" && !S.over && !busy && canAttack(u);
      if (ok) el.setAttribute("draggable", "true");
      else el.removeAttribute("draggable");
    });
  }

  /* ============================================================
     十六、移动端触摸拖拽（旁路：桌面仍走 HTML5 DnD）
     ------------------------------------------------------------
     手机上 HTML5 drag&drop 不触发，且默认触摸手势会滚屏。这里用
     Pointer Events 自绘「牌影」跟随手指，落点向目标元素派发合成的
     dragover / drop 事件，从而完整复用桌面那一套 drop 逻辑。
     ============================================================ */

  const TD = { on: false, kind: null, el: null, obj: null, ghost: null, hover: null, x0: 0, y0: 0, id: null, moved: false };
  const TD_TAP = 12;
  let TD_SUPPRESS = null;

  document.addEventListener("click", e => {
    const s = TD_SUPPRESS;
    if (!s) return;
    if (Date.now() - s.at < 700 && s.el && (e.target === s.el || s.el.contains(e.target))) {
      e.stopPropagation();
      e.preventDefault();
      TD_SUPPRESS = null;
    }
  }, true);

  function tdDown(e, kind, obj, el) {
    if (TD.on || !obj) return;
    if (kind === "unit" && (S.active !== S.p || S.phase !== "battle" || !canAttack(obj))) return;
    TD.on = true;
    TD.kind = kind;
    TD.el = el;
    TD.obj = obj;
    TD.x0 = e.clientX;
    TD.y0 = e.clientY;
    TD.id = e.pointerId;
    TD.moved = false;
    // 全局监听，不用 setPointerCapture：起拖后手牌卡会被设成 pointer-events:none，
    // 真机上这会打断指针捕获、后续事件全部收不到——拖拽就死在第一步。
    window.addEventListener("pointermove", tdMove, { passive: false });
    window.addEventListener("pointerup", tdUp);
    window.addEventListener("pointercancel", tdCancel);
  }

  function tdMove(e) {
    if (!TD.on || e.pointerId !== TD.id) return;
    const dx = e.clientX - TD.x0, dy = e.clientY - TD.y0;
    if (!TD.moved) {
      if (dx * dx + dy * dy < TD_TAP * TD_TAP) return;
      tdBegin();
    }
    e.preventDefault();
    tdGhostAt(e.clientX, e.clientY);
    tdHover(e.clientX, e.clientY);
  }

  function tdBegin() {
    TD.moved = true;
    document.body.classList.add("g-touch-dragging");
    const isUnit = TD.kind === "unit";
    const g = document.createElement("div");
    g.className = "g-touch-ghost" + (isUnit ? " g-unit" : "");
    g.style.width = (isUnit ? 46 : 96) + "px";
    g.innerHTML = `<img src="${TD.obj.card ? TD.obj.card.img : TD.obj.img}" alt="">`;
    document.body.appendChild(g);
    TD.ghost = g;
    if (isUnit) startUnitDrag(TD.obj);
    else startCardDrag(TD.obj);
  }

  function tdGhostAt(x, y) {
    if (!TD.ghost) return;
    TD.ghost.style.left = x + "px";
    TD.ghost.style.top = y + "px";
  }

  // 手指下方最近的可放置目标：几何命中而不用 elementFromPoint
  function tdHover(x, y) {
    const inRect = r => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    let t = null;
    for (const u of document.querySelectorAll(".g-unit")) {
      if (inRect(u.getBoundingClientRect())) { t = u; break; }
    }
    if (!t) {
      for (const sel of ["#z-field-a", "#z-field-p", "#z-energy", "#g-fillzone"]) {
        const el = document.querySelector(sel);
        if (el && (sel !== "#g-fillzone" || el.classList.contains("show")) && inRect(el.getBoundingClientRect())) {
          t = el;
          break;
        }
      }
    }
    if (!t) {
      const m = $("g-mat");
      if (inRect(m.getBoundingClientRect())) t = m;
    }
    if (t === TD.hover) return;
    if (TD.hover) {
      TD.hover.classList.remove("drag-over");
      tdFire(TD.hover, "dragleave", x, y);
    }
    TD.hover = t;
    if (t) tdFire(t, "dragover", x, y);
  }

  const tdFire = (el, type, x, y) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y }));

  function tdOff() {
    window.removeEventListener("pointermove", tdMove);
    window.removeEventListener("pointerup", tdUp);
    window.removeEventListener("pointercancel", tdCancel);
    const el = TD.el;
    if (el && TD.id != null) { try { el.releasePointerCapture(TD.id); } catch (_) {} }
    TD.on = false;
    TD.id = null;
  }

  function tdTeardown() {
    if (TD.ghost) { TD.ghost.remove(); TD.ghost = null; }
    if (TD.hover) { TD.hover.classList.remove("drag-over"); TD.hover = null; }
    endDrag();
  }

  function tdTap(el, x, y) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y }));
    TD_SUPPRESS = { el, at: Date.now() };
  }

  function tdUp(e) {
    if (!TD.on || e.pointerId !== TD.id) return;
    const el = TD.el, moved = TD.moved, kind = TD.kind, obj = TD.obj, x = e.clientX, y = e.clientY;
    tdOff();
    if (!moved) {
      tdTap(el, x, y);
      if (kind === "card") handCardMenu(obj);
      return;
    }
    const t = TD.hover;
    TD.hover = null;
    if (t) tdFire(t, "drop", x, y);
    tdTeardown();
  }

  function tdCancel() {
    if (!TD.on) return;
    tdOff();
    tdTeardown();
  }

  // 手牌操作菜单：点一下手牌就能打出 / 填能（拖拽仍是备选）
  async function handCardMenu(card) {
    if (!card || S.over || busy || S.active !== S.p || !S.started) return;
    const opts = [];
    const isEquip = card.type === "装备";
    if (S.phase === "main" && !isEquip) {
      opts.push({
        label: `打出「${card.name}」`,
        sub: (card.type === "角色" ? "登场到自己战场" : "结算效果后进废弃区") +
             ` · 费用 ${card.cost ?? "-"}${card.power != null ? " · 战力 " + card.power : ""}`,
        img: card.img,
        value: "play"
      });
    }
    if (S.phase === "main" && isEquip) {
      const targets = S.p.field.filter(u => equipOk(u, card));
      targets.forEach(u => opts.push({
        label: `装备给「${u.card.name}」`,
        sub: `战力 ${effPower(u)} → ${effPower(u) + (card.power || 0) + (u.card.id === "card09" ? 500 : 0)}`,
        img: u.card.img,
        value: { equip: u }
      }));
      if (!targets.length) opts.push({ label: "没有可装备的角色", sub: "先把角色打到场上", value: "noop" });
    }
    if (S.phase === "fill" && !S.p.filledThisTurn) {
      opts.push({ label: `填入能量区`, sub: "本回合限填 1 张，活跃状态入区", img: card.img, value: "fill" });
    }
    if (!opts.length) { gToast(noActionReason(card)); return; }

    // 只有一个可行操作时直接执行，省掉一次点击
    let v;
    if (opts.length === 1 && opts[0].value !== "noop") {
      v = opts[0].value;
    } else {
      const withCancel = [...opts, { label: "取消", value: null }];
      v = await choose(`「${card.name}」要做什么？`, withCancel);
    }

    if (v === "play") {
      if (!canPay(S.p, card)) { gToast("费用不足，或没有对应属性能量"); return; }
      busy = true; render();
      await playCard(S.p, card, false);
      busy = false; render();
    } else if (v === "fill") {
      fillEnergy(S.p, card);
    } else if (v && v.equip) {
      if (!canPay(S.p, card)) { gToast("费用不足，或没有对应属性能量"); return; }
      busy = true; render();
      await playCard(S.p, card, false, v.equip);
      busy = false; render();
    } else if (v === "noop") {
      gToast("没有可装备的角色");
    }
  }

  function noActionReason(card) {
    if (!S.started) return "先点场地中央的【开始战斗】掷骰定先手";
    if (S.phase === "draw") return "现在是抽牌阶段，稍等一下";
    if (S.phase === "fill") return S.p.filledThisTurn ? "本回合已填过能量（每回合限 1 张）" : "";
    if (S.phase === "main") return "费用不足，或没有对应属性的能量";
    if (S.phase === "battle") return "现在是战斗阶段，只能发起攻击";
    return "现在不能使用这张卡";
  }

  /* ============================================================
     十七、布局自适应 + 横屏门禁
     ============================================================ */

  // 新版布局是纯 CSS flex（顶栏 + 棋盘 + 手牌条），棋盘自动吃掉剩余高度，
  // 不再需要按竖屏比例反算宽度。这里只负责重算单位卡宽度。
  function fitBoard() {
    if (S) fitUnits();
  }

  let rotForced = false;
  function isTouchPortrait() {
    const portrait = window.matchMedia
      ? window.matchMedia("(orientation: portrait)").matches
      : window.innerHeight > window.innerWidth;
    if (!portrait) return false;
    const coarse = window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    return !!(coarse || (navigator.maxTouchPoints || 0) > 0);
  }
  function syncRotate() {
    const gate = $("g-rotate");
    const inPlay = !!(gate && $("page-play") && $("page-play").classList.contains("active"));
    const need = inPlay && !rotForced && isTouchPortrait();
    if (gate) gate.classList.toggle("on", need);
    document.body.classList.toggle("g-locked", inPlay);
    return need;
  }

  /* ============================================================
     十八、启动
     ============================================================ */

  function newGame() {
    const pick = (window.GTCG_DECKS && window.GTCG_DECKS.playPick()) || { p: "a", a: "b" };
    S = {
      p: newSide("你", pick.p),
      a: newSide("AI", pick.a),
      turnCount: 0, over: false, active: null, phase: null,
      started: false, firstSide: null
    };
    $("g-log").innerHTML = "";
    $("g-end").disabled = true;
    clearMemo();
    ["z-field-p", "z-field-a", "z-energy", "z-energy-a", "z-deck", "z-discard",
     "z-deck-a", "z-discard-a", "z-ex", "z-ex-a", "g-hand"].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = "";
    });
    drawCards(S.p, HAND_START);
    drawCards(S.a, HAND_START);
    log(`对局准备：你使用「${S.p.deckName}」，AI 使用「${S.a.deckName}」，各 ${DECK_SIZE} 张，已起手 ${HAND_START} 张。`, "g-hot");
    log("点场地中央的【开始战斗】掷骰定先手——点数大者先手，先手第一回合不抽牌。", "g-hot");
    if (!S.p.deckId || !S.a.deckId) {
      log("提示：所选卡组不是合法的 40 张构筑，已回退随机牌组。到「坎友卡牌中心 → 我的卡组」构筑后再来。", "g-hot");
    }
    render();
  }

  function initUI() {
    // 重新开始：移到视口右下角 + 二次确认，防误触
    $("g-restart").addEventListener("click", () => {
      if (busy) return;
      if (!confirm("确定要重新开始吗？当前对局的进度会全部丢失。")) return;
      newGame();
    });
    $("g-end").addEventListener("click", () => { nextPhase(); });

    const startBtn = $("g-start-btn");
    if (startBtn) startBtn.addEventListener("click", () => { startBattle(); });

    // 横屏门禁
    const gate = $("g-rotate");
    if (gate) {
      const force = $("g-rotate-force");
      if (force) force.addEventListener("click", () => { rotForced = true; syncRotate(); });
      if (window.MutationObserver && $("page-play")) {
        new MutationObserver(() => {
          if (!$("page-play").classList.contains("active")) rotForced = false;
          syncRotate();
          fitBoard();
        }).observe($("page-play"), { attributes: true, attributeFilter: ["class"] });
      }
      window.addEventListener("resize", () => { syncRotate(); fitBoard(); });
      window.addEventListener("orientationchange", () => setTimeout(() => { syncRotate(); fitBoard(); }, 60));
      syncRotate();
      fitBoard();
      requestAnimationFrame(() => { fitBoard(); setTimeout(fitBoard, 120); });
    }

    // 手牌悬浮层：dock 左侧按钮切换显示/隐藏
    const btn = $("g-hand-toggle");
    if (btn) {
      const sync = () => {
        btn.textContent = document.body.classList.contains("hand-hidden") ? "显示手牌" : "隐藏手牌";
      };
      btn.addEventListener("click", () => {
        document.body.classList.toggle("hand-hidden");
        sync();
      });
      sync();
    }

    // 右侧信息抽屉
    const drawer = $("g-drawer");
    const pbtn = $("g-panel-btn");
    if (drawer && pbtn) {
      const toggle = on => drawer.classList.toggle("open", on === undefined ? !drawer.classList.contains("open") : on);
      pbtn.addEventListener("click", () => toggle());
      const close = $("g-drawer-close");
      if (close) close.addEventListener("click", () => toggle(false));
    }

    // 填能落点：点一下 = 提示选手牌（比拖拽更容易上手）
    const fz = $("g-fillzone");
    if (fz) {
      fz.addEventListener("click", () => {
        if (!S || S.over || busy || S.active !== S.p) return;
        if (S.phase !== "fill") { gToast("现在是" + (PHASE_NAME[S.phase] || "其它阶段") + "，只能在填能阶段填能量"); return; }
        if (S.p.filledThisTurn) { gToast("本回合已经填过能量了"); return; }
        gToast("点手牌里任意一张，即可填入能量区");
      });
    }

    // 卡组改动（重命名/构筑）后刷新对局状态栏显示
    if (window.GTCG_DECKS) window.GTCG_DECKS.onChange = () => { if (S) render(); };
  }

  /* ============================================================
     十九、调试 / 测试钩子
     ============================================================ */

  window.GTCG_DEBUG = {
    get S() { return S; },
    isBusy: () => busy,
    newGame,
    // 测试用：指定手牌/牌库/能量区/阶段
    rig: o => {
      if (!S) return false;
      if (o.hand) S.p.hand = o.hand.map(byId);
      if (o.deck) S.p.deck = o.deck.map(byId);
      if (o.energy) S.p.energy = o.energy.map(id => ({ card: byId(id), tapped: false }));
      if (o.enemy) S.a.field = o.enemy.map(id => { const u = newUnit(byId(id)); u.playedTurn = -1; return u; });
      if (o.phase) { S.phase = o.phase; S.active = S.p; }
      if (o.filledThisTurn !== undefined) S.p.filledThisTurn = o.filledThisTurn;
      render();
      return true;
    },
    fill: i => {
      if (S && S.p.hand[i]) { S.phase = "fill"; return fillEnergy(S.p, S.p.hand[i]); }
      return false;
    },
    play: async i => {
      if (!S || !S.p.hand[i]) return false;
      S.phase = "main";
      busy = true;
      try { return await playCard(S.p, S.p.hand[i], false); }
      finally { busy = false; }
    },
    equipTo: async (i, uid) => {
      const c = S.p.hand[i], u = S.p.field.find(x => x.uid === uid);
      if (!c || !u || !equipOk(u, c) || !canPay(S.p, c)) return false;
      S.phase = "main";
      tryPay(S.p, c);
      S.p.hand.splice(S.p.hand.indexOf(c), 1);
      applyEquip(S.p, u, c);
      render();
      return true;
    },
    attack: async (uid, target) => {
      const u = S.p.field.find(x => x.uid === uid);
      if (!u) return false;
      S.phase = "battle";
      await declareAttack(S.p, S.a, u, target);
      return true;
    },
    nextPhase,
    startBattle,
    rollDice,
    diceHtml: dieHtml,
    prepareEnergy,
    // 移动端适配测试钩子
    rot: {
      sync: syncRotate,
      portrait: isTouchPortrait,
      force: v => { rotForced = !!v; syncRotate(); },
      shown: () => { const g = $("g-rotate"); return !!g && g.classList.contains("on"); },
      locked: () => document.body.classList.contains("g-locked"),
      fit: fitBoard,
      matW: () => { const m = $("g-mat"); return m ? Math.round(m.getBoundingClientRect().width) : -1; },
      overflow: () => document.documentElement.scrollHeight - window.innerHeight
    },
    handCardMenu,
    td: { get state() { return { on: TD.on, kind: TD.kind, moved: TD.moved, hover: !!TD.hover }; } },
    endTurn: async () => { await endTurn(); },
    // 卡牌行为登记表（便于测试逐张验证）
    tables: { ON_ENTER, ON_EVENT, ON_ATTACK, ON_GUARD, ON_RESONATE, ON_EQUIP, AI_WANTS },
    core: {
      tryPay, canPay, effPower, addResonance, pickPayment, choosePayment, payFor,
      destroy, bounce, hasGuard, hasRaid, canAttack, attackableTargets, battle,
      checkDestroy, fillEnergy, playCard, declareAttack, cleanupTurnEnd, startTurn
    },
    render
  };

  initUI();
  newGame();
})();
