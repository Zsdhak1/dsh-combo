/**
 * @local/dsh-combo — browser half.
 *
 * A Devil May Cry style combo HUD drawn in the empty gutters beside the
 * conversation column. Two halves, split by capability:
 *
 *   PROBE  — registered at `conversation.input.dock`, the only session-scoped
 *            slot that hands out `useInput` / `useChat` / `useSessionStatus`.
 *            It runs the combo state machines, measures where the composer
 *            column actually sits, and publishes both to a module store. It
 *            renders a zero-height in-flow marker and nothing else.
 *
 *   RAILS  — registered at `shell.overlay`, the frame-wide floating layer built
 *            for exactly this ("a badge, a toast stack or a status pill"). It
 *            subscribes to the store and paints the two rails. Drawing here
 *            keeps the rails out of the composer's layout containment, which is
 *            what broke `position: fixed` inside the composer stack.
 *
 * Two lanes, one per side, because their currencies differ:
 *
 *   YOU   (left)  — every character that lands in the composer is a hit.
 *                   Typing fast and without pause raises your rank. Sending
 *                   freezes the achieved rank until the next turn settles.
 *   AGENT (right) — every settled Tool call is a hit; a failed call or a turn
 *                   error breaks the chain. The achieved rank STAYS on screen
 *                   after the turn ends and is replaced only when the next turn
 *                   starts, so a good run is not erased the moment it finishes.
 *
 * Settings (enabled + effect intensity) live in localStorage under one key so
 * the HUD and the General-settings row stay in sync without a Host round trip.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-combo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Build stamp, bumped on every edit. It is rendered in the corner badge so a
     * page refresh can be confirmed by eye: if the badge still shows the old
     * stamp, the browser is serving the previous module generation.
     */
    const BUILD = '2026-10-22 15:38:09';

    /** Route the Host half serves the resolved tuning document on. */
    const CONFIG_PATH = '/plugins/dsh-combo/config.json';

    /**
     * Apply a Host-supplied tuning document over the built-in defaults.
     *
     * Every field is optional and every value is re-validated here: the document
     * crosses an HTTP boundary and may be hand-edited YAML upstream, so it is
     * treated as untrusted input rather than trusted configuration. A rejected
     * field simply keeps its default.
     *
     * @param doc - parsed JSON from the Host route.
     */
    function applyHostConfig(doc) {
      if (doc === null || typeof doc !== 'object') return;

      // Rank names: appended above the built-in ladder, never replacing it, so an
      // existing personal best remains meaningful.
      if (Array.isArray(doc.extraRanks)) {
        const extras = doc.extraRanks
          .filter((name) => typeof name === 'string' && name.trim() !== '')
          .map((name) => name.trim())
          .slice(0, 4);
        if (extras.length > 0) {
          RANKS.length = 0;
          RANKS.push('D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'SSS+', 'V', ...extras);
        }
      }

      /** Read a threshold list, keeping only strictly increasing positives. */
      const ladder = (values) => {
        if (!Array.isArray(values)) return null;
        const cleaned = [];
        for (const value of values) {
          const next = Math.round(Number(value));
          if (!Number.isFinite(next) || next <= 0) continue;
          if (cleaned.length > 0 && next <= cleaned[cleaned.length - 1]) continue;
          cleaned.push(next);
        }
        return cleaned.length > 0 ? cleaned : null;
      };
      const youLadder = ladder(doc.youLadder);
      if (youLadder !== null) {
        USER_LADDER.length = 0;
        USER_LADDER.push(...youLadder);
      }
      const agentLadder = ladder(doc.agentLadder);
      if (agentLadder !== null) {
        AGENT_LADDER.length = 0;
        AGENT_LADDER.push(...agentLadder);
      }

      const positive = (value, max) => {
        const next = Number(value);
        return Number.isFinite(next) && next > 0 && next <= max ? next : null;
      };
      const youIdle = positive(doc.youIdleMs, 600000);
      if (youIdle !== null) USER_IDLE_MS = Math.round(youIdle);
      const agentIdle = positive(doc.agentIdleMs, 600000);
      if (agentIdle !== null) AGENT_IDLE_MS = Math.round(agentIdle);
      const decay = positive(doc.youDecayPerSec, 1000);
      if (decay !== null) USER_DECAY_PER_SEC = decay;

      const phrases = (values) => {
        if (!Array.isArray(values)) return null;
        const cleaned = values
          .filter((line) => typeof line === 'string' && line.trim() !== '')
          .map((line) => line.trim());
        return cleaned.length > 0 ? cleaned : null;
      };
      const youPhrases = phrases(doc.youPhrases);
      if (youPhrases !== null) QUIPS.you = youPhrases;
      const agentPhrases = phrases(doc.agentPhrases);
      if (agentPhrases !== null) QUIPS.agent = agentPhrases;
    }

    /**
     * Fetch the Host tuning document and apply it.
     *
     * Deliberately fire-and-forget: activation must not depend on an HTTP round
     * trip, and a missing route (headless profile) is a normal outcome rather
     * than an error worth surfacing. The HUD renders with defaults first and
     * picks up the document whenever it lands.
     */
    function loadHostConfig() {
      if (typeof fetch !== 'function') return;
      fetch(CONFIG_PATH, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((doc) => {
          if (doc !== null) applyHostConfig(doc);
        })
        .catch(() => {
          // No route, no server, or invalid JSON: keep the built-in defaults.
        });
    }

    // ── rank ladder ────────────────────────────────────────────────────────
    /**
     * Letters from lowest to highest, DMC order plus the two Devil Trigger tiers
     * that DMC5 adds above SSS. Nine rungs instead of seven: the previous ceiling
     * was reachable in a normal paragraph, which left nothing to climb toward.
     */
    /**
     * Letters from lowest to highest, DMC order plus the two Devil Trigger tiers
     * that DMC5 adds above SSS.
     *
     * Held in a mutable object because the Host config may append extra ranks;
     * the values below are the built-in defaults used when no Host config is
     * served (a bare web build, or a profile without a web server).
     */
    const RANKS = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'SSS+', 'V'];
    /**
     * Characters needed to reach C..V on the YOU lane.
     *
     * Deliberately lower than the Agent's ladder: a person types maybe a few
     * dozen characters per message while the Agent lands a dozen tool calls per
     * turn, so the two currencies are not comparable. The early rungs stay cheap
     * so a sentence still shows progress; the top rungs are deliberately far away
     * so V means something.
     */
    const USER_LADDER = [7, 16, 29, 47, 70, 101, 150, 230];
    /** Tool calls needed to reach C..V on the AGENT lane. */
    const AGENT_LADDER = [2, 4, 7, 11, 16, 22, 30, 42];
    /** Rungs used to colour the letter. Computed on read: the Host config may
     *  append extra ranks, so a captured length would go stale. */
    const rankCount = () => RANKS.length;

    /**
     * Hit reactions: short lines that pop out of the letter on a strike. Kept
     * deliberately terse and mechanical rather than conversational, so they read
     * as HUD feedback and never as the product talking to the user.
     *
     * Split by lane because the two sides are doing different things: YOU is
     * typing, AGENT is running tools.
     */
    const QUIPS = {
      you: ['击中', '连段', '跟上', '不错', '再来', '稳住', '走起', '漂亮', '续上', '节奏'],
      agent: ['命中', '命中', '执行', '到位', '连招', '推进', '拿下', '有效', '生效', '通过'],
      /**
       * Rank-specific lines. These fire only when the rank steps up, and are the
       * only place the HUD allows itself a little attitude.
       */
      rankUp: {
        C: ['起手', '开始了'],
        B: ['节奏对', '手感来了'],
        A: ['状态好', '继续压'],
        S: ['很猛', '打穿了'],
        SS: ['停不下来', '别断'],
        SSS: ['满速', '彻底接管'],
        'SSS+': ['超频', '过载了'],
        V: ['封顶', '无法再高'],
      },
    };
    /** How long a quip stays on screen, in ms. */
    const QUIP_MS = 900;
    /** Vertical travel of a rising quip, in px. */
    const QUIP_RISE = 44;
    /** Typing-rate window and floor, for the characters-per-second read-out. */
    const CPS_WINDOW_MS = 2500;
    const CPS_MIN_SPAN_MS = 400;

    /**
     * Idle window before the YOU lane starts draining, in ms.
     *
     * Deliberately long. An IME needs time to commit a composition, and a paused
     * typist is usually mid-thought: draining during that hesitation reads as the
     * meter fighting the user, which is the fastest way to make the HUD feel
     * hostile. The drain itself is slow, so nothing is lost by waiting here.
     */
    /** Mutable: the Host config may override these (see applyHostConfig). */
    let USER_IDLE_MS = 3000;
    let AGENT_IDLE_MS = 25000;
    /** Drain rate for the YOU lane, in combo points per second. */
    let USER_DECAY_PER_SEC = 5;
    /**
     * How long a rank-up burst stays mounted, in ms.
     *
     * Must exceed the longest burst animation (the slowest ring runs 1040ms plus
     * its delay), otherwise the layer unmounts mid-flight and the effect visibly
     * cuts off — which is exactly what a short window used to cause.
     */
    const RANKUP_MS = 1500;
    /** Cap on the de-duplication set so a long session cannot grow it forever. */
    const PROCESSED_CAP = 2000;
    /**
     * How long the per-hit strike marker stays lit, in ms.
     *
     * This gates when the hit layers are mounted, so it has to outlast the
     * animations those layers run: the burst takes up to ~900ms and the streak
     * ~660ms. At the old 320ms the DOM was torn down before the animation ended.
     */
    const HIT_MS = 950;
    /** How long the strike animations themselves run, in ms (kept in sync). */
    const HIT_ANIM_MS = 520;
    /**
     * How long a combo-break animation stays mounted, in ms.
     *
     * Kept close to the shard animation (520ms plus the last shard's 88ms delay)
     * rather than longer: the flag drives a reveal animation on the real glyph,
     * and an over-long window re-triggers that reveal on every re-render instead
     * of showing the new rank steadily.
     */
    const BREAK_MS = 640;
    /** How often the lanes are evaluated for decay, in ms. */
    const TICK_MS = 150;
    /** How many recent distinct tool names the move log keeps. */
    const MOVE_LOG_MAX = 4;
    /** How long a new-record flourish stays mounted, in ms. */
    const BEST_MS = 1600;
    /** Minimum gutter width, in px, before a rail gives up and hides. */
    const MIN_GUTTER = 96;
    /** Breathing room kept between a rail and the content / panel edge. */
    const GUTTER_INSET = 12;
    /** Widest a rail is allowed to grow, in px. */
    const MAX_GUTTER = 196;
    /** Width of the charge bar, in px. Must match `.dshcombo-charge`. */
    const CHARGE_WIDTH = 176;
    /**
     * Tick positions on the charge column, in percent from its bottom. These are
     * the rung boundaries of the ladder, so the marks line up with where the rank
     * letter actually changes. One tick per rung above D.
     */
    const TICKS = [12, 24, 36, 48, 60, 72, 84, 94];

    /**
     * Map a hit count to its rank letter.
     * @param hits - accumulated hits.
     * @param ladder - ascending thresholds for C..SSS.
     * @returns the rank letter.
     */
    function rankOf(hits, ladder) {
      let index = 0;
      for (let i = 0; i < ladder.length; i += 1) if (hits >= ladder[i]) index = i + 1;
      return RANKS[index];
    }

    /**
     * Progress towards the next rank, 0..1 — drives the charge bar.
     * @param hits - accumulated hits.
     * @param ladder - ascending thresholds for C..SSS.
     * @returns fill ratio.
     */
    function chargeOf(hits, ladder) {
      if (hits <= 0) return 0;
      if (hits >= ladder[ladder.length - 1]) return 1;
      let floor = 0;
      let next = ladder[0];
      for (let i = 0; i < ladder.length; i += 1) {
        if (hits >= ladder[i]) {
          floor = ladder[i];
          next = ladder[i + 1] ?? ladder[i];
        } else {
          next = ladder[i];
          break;
        }
      }
      if (next <= floor) return 1;
      return Math.min(1, Math.max(0, (hits - floor) / (next - floor)));
    }

    /**
     * Numeric position of a rank on the ladder, for "did it step up?" checks.
     * @param rank - a letter from RANKS.
     * @returns index 0..6; -1 for an unknown letter.
     */
    function rankIndex(rank) {
      return RANKS.indexOf(rank);
    }

    /**
     * Compact token count for the context read-out: 1.2K, 18.4M, and so on.
     * @param value - raw token count.
     * @returns display string.
     */
    function compactCount(value) {
      if (!Number.isFinite(value) || value < 0) return '0';
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`;
      return `${(value / 1000000).toFixed(1)}M`;
    }

    // ── module store shared by the probe and the rails ─────────────────────
    /**
     * One mutable snapshot plus a listener set. The probe is the only writer;
     * every rail subscriber reads. Kept outside React so the two slot entries
     * (which live in different trees) can share it.
     */
    const store = {
      /**
       * @type {{userHits:number, agentHits:number, userFrozen:number,
       *   agentFrozen:number, lastMove:string, moveLog:string[], running:boolean,
       *   userHitAt:number, agentHitAt:number, live:boolean,
       *   userBreakAt:number, agentBreakAt:number,
       *   userBreakRank:string, agentBreakRank:string}}
       */
      state: {
        userHits: 0,
        agentHits: 0,
        userFrozen: 0,
        agentFrozen: 0,
        lastMove: '',
        // Recent tool names, newest last. A single name could not show whether
        // the Agent was varying its tools or repeating one, which is the most
        // informative thing the lane can display.
        moveLog: [],
        running: false,
        userHitAt: 0,
        agentHitAt: 0,
        live: false,
        // When a lane's combo was lost, and the rank it held at that moment. The
        // rail uses the rank to size the break animation: losing an SSS deserves
        // a bigger collapse than losing a C.
        userBreakAt: 0,
        agentBreakAt: 0,
        userBreakRank: '',
        agentBreakRank: '',
      },
      /**
       * Measured read-outs, kept apart from the combo state because they update
       * on a different cadence and are plain display values:
       *   cps      — characters per second the user is typing at
       *   tps      — the model's output tokens per second this session
       *   context  — total prompt+output tokens currently in context
       */
      metrics: { cps: 0, tps: 0, context: 0 },
      /** @type {{columnLeft:number, columnRight:number, frameLeft:number, frameRight:number}} */
      geometry: { columnLeft: 0, columnRight: 0, frameLeft: 0, frameRight: 0 },
      listeners: new Set(),
      /**
       * Replace part of the snapshot and wake subscribers. Only changed keys are
       * compared, so a no-op publish costs nothing. Arrays are compared by
       * content: `moveLog` is rebuilt on every tool call, so a reference check
       * would report a change on every publish and re-render the rails for
       * nothing.
       * @param patch - partial state.
       */
      publish(patch) {
        let changed = false;
        for (const key of Object.keys(patch)) {
          const next = patch[key];
          const current = store.state[key];
          if (Array.isArray(next) && Array.isArray(current)) {
            if (next.length !== current.length || next.some((item, index) => item !== current[index])) {
              changed = true;
            }
          } else if (current !== next) {
            changed = true;
          }
          store.state[key] = next;
        }
        if (!changed) return;
        for (const listener of store.listeners) listener();
      },
      /**
       * Replace the measured read-outs and wake subscribers when they move.
       * Values are rounded before comparison so sub-unit jitter never re-renders.
       * @param next - partial metrics.
       */
      publishMetrics(next) {
        let changed = false;
        for (const key of Object.keys(next)) {
          const value = Math.round(next[key] * 10) / 10;
          if (store.metrics[key] !== value) changed = true;
          store.metrics[key] = value;
        }
        if (!changed) return;
        for (const listener of store.listeners) listener();
      },
      /**
       * Replace the measured geometry and wake subscribers when it moved.
       * @param next - viewport-space rectangle edges.
       */
      publishGeometry(next) {
        const current = store.geometry;
        if (
          current.columnLeft === next.columnLeft
          && current.columnRight === next.columnRight
          && current.frameLeft === next.frameLeft
          && current.frameRight === next.frameRight
        ) return;
        store.geometry = next;
        for (const listener of store.listeners) listener();
      },
      /** Subscribe; returns the disposer. */
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
    };

    /** Re-render a component whenever the store changes. */
    function useStoreState() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => store.subscribe(() => force()), []);
      return store;
    }

    // ── settings store (localStorage, one key) ─────────────────────────────
    const STORAGE_KEY = 'dsh-combo.settings';
    const DEFAULTS = { enabled: true, intensity: 70, quips: true, stats: true };
    const settings = { ...DEFAULTS };
    const settingsListeners = new Set();
    let settingsLoaded = false;

    /** Read the persisted settings once; malformed JSON keeps the defaults. */
    function loadSettings() {
      if (settingsLoaded) return;
      settingsLoaded = true;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return;
        if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled;
        if (typeof parsed.quips === 'boolean') settings.quips = parsed.quips;
        if (typeof parsed.stats === 'boolean') settings.stats = parsed.stats;
        if (typeof parsed.intensity === 'number' && Number.isFinite(parsed.intensity)) {
          settings.intensity = Math.min(100, Math.max(0, Math.round(parsed.intensity)));
        }
      } catch (error) {
        console.error('[combo] could not read settings', error);
      }
    }

    /**
     * Merge a patch into the live settings, persist it, and wake every HUD.
     * @param patch - fields to change.
     */
    function updateSettings(patch) {
      loadSettings();
      if (patch.enabled !== undefined) settings.enabled = patch.enabled === true;
      if (patch.quips !== undefined) settings.quips = patch.quips === true;
      if (patch.stats !== undefined) settings.stats = patch.stats === true;
      if (patch.intensity !== undefined) {
        settings.intensity = Math.min(100, Math.max(0, Math.round(Number(patch.intensity) || 0)));
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          enabled: settings.enabled,
          intensity: settings.intensity,
          quips: settings.quips,
          stats: settings.stats,
        }));
      } catch (error) {
        console.error('[combo] could not persist settings', error);
      }
      for (const listener of settingsListeners) listener();
    }

    /** Subscribe a component to settings changes; returns the live settings. */
    function useSettings() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => {
        loadSettings();
        const listener = () => force();
        settingsListeners.add(listener);
        return () => {
          settingsListeners.delete(listener);
        };
      }, []);
      loadSettings();
      return settings;
    }

    // ── personal best storage ──────────────────────────────────────────────
    const BEST_KEY = 'dsh-combo.bests';

    /**
     * Read the persisted personal bests.
     *
     * Stored as `{ user: {rank, hits}, agent: {rank, hits} }`; a malformed or
     * missing entry yields an empty record rather than failing the HUD.
     *
     * @returns per-lane best records.
     */
    function loadBests() {
      const empty = {
        user: { rank: '', hits: 0 },
        agent: { rank: '', hits: 0 },
      };
      try {
        const raw = window.localStorage.getItem(BEST_KEY);
        if (raw === null) return empty;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return empty;
        for (const lane of ['user', 'agent']) {
          const entry = parsed[lane];
          if (entry === null || typeof entry !== 'object') continue;
          if (typeof entry.rank === 'string' && RANKS.includes(entry.rank)) empty[lane].rank = entry.rank;
          if (typeof entry.hits === 'number' && Number.isFinite(entry.hits) && entry.hits >= 0) {
            empty[lane].hits = Math.round(entry.hits);
          }
        }
        return empty;
      } catch (error) {
        console.error('[combo] could not read bests', error);
        return empty;
      }
    }

    /**
     * Persist the personal bests. Failures are logged and ignored: a full or
     * blocked localStorage must not break the HUD.
     * @param bests - the record to store.
     */
    function saveBests(bests) {
      try {
        window.localStorage.setItem(BEST_KEY, JSON.stringify(bests));
      } catch (error) {
        console.error('[combo] could not persist bests', error);
      }
    }

    // ── locale ─────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        you: '你',
        agent: 'AGENT',
        ready: '出招',
        combo: '连击',
        settingsTitle: '连击 HUD',
        settingsHint: '对话栏两侧的连击评价：打字蓄力，Agent 的工具调用命中并提升评价。',
        settingsEnable: '显示连击 HUD',
        settingsIntensity: '特效强度',
        settingsQuips: '命中评语',
        settingsStats: '数据显示',
        breakLabel: '断连',
        best: '最佳',
      },
      en: {
        you: 'YOU',
        agent: 'AGENT',
        ready: 'READY',
        combo: 'COMBO',
        settingsTitle: 'Combo HUD',
        settingsHint: 'The combo rank in the gutters beside the conversation: typing charges it, the Agent’s tool calls land hits and raise the rank.',
        settingsEnable: 'Show the combo HUD',
        settingsIntensity: 'Effect intensity',
        settingsQuips: 'Hit quips',
        settingsStats: 'Read-outs',
        breakLabel: 'BREAK',
        best: 'BEST',
      },
    };
    /** Active translator; replaced by apply() when the locale service exists. */
    let translate = (key) => DICT.en[key] ?? key;
    /** Look one key up in the active dictionary. */
    const t = (key) => {
      const value = translate(key);
      return typeof value === 'string' && value !== '' ? value : key;
    };

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS = `
/* In-flow probe: occupies the composer column's width so its rectangle is the
   column, but draws nothing and adds no height. */
.dshcombo-probe {
  display: block;
  width: 100%;
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  pointer-events: none;
}
/* Clipping root: spans ONLY the conversation frame (never the sidebar or the
   right panel) and clips its contents. Effects are large on purpose, so without
   this they bleed into the sidebar's own background and the page stops reading
   as one surface. Clipping here keeps every burst inside the conversation area
   while still letting it cover a large part of that area. */
.dshcombo-root {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 3;
  overflow: hidden;
  font-family: var(--dsw-font-family, inherit);
}
/* ══ rail shell ═══════════════════════════════════════════════════════════
   Composition is deliberately ASYMMETRIC and mirrored, not centred: the rank
   letter hugs the outer edge and the charge column rides the inner edge, so the
   two rails read as one frame around the conversation instead of two stickers.
   At rest a rail is dim and desaturated; the active side lights up. */
.dshcombo-rail {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  user-select: none;
  pointer-events: none;
  opacity: 0.28;
  filter: saturate(0.3) brightness(0.8);
  transition: opacity 340ms ease, filter 340ms ease;
}
.dshcombo-rail[data-lit="true"] {
  opacity: 1;
  filter: none;
}
.dshcombo-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
}
/* Mirror the stack: YOU hugs the left edge, AGENT hugs the right edge. */
.dshcombo-rail[data-side="you"] .dshcombo-inner { align-items: flex-start; }
.dshcombo-rail[data-side="agent"] .dshcombo-inner { align-items: flex-end; }

/* ── the lane label: tiny, tracked out, tucked at the outer edge ─────────── */
.dshcombo-tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.55;
  white-space: nowrap;
}
.dshcombo-rail[data-lit="true"] .dshcombo-tag {
  color: var(--dswcombo-accent);
  opacity: 1;
}

/* ── the plate: letter, slash, and every hit effect in one box ───────────── */
.dshcombo-plate {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 88px;
}
.dshcombo-rail[data-side="you"] .dshcombo-plate { justify-content: flex-start; }
.dshcombo-rail[data-side="agent"] .dshcombo-plate { justify-content: flex-end; }

/* The letter's own box is the origin for every effect. Because the letter is
   edge-aligned (not centred in the plate), anchoring effects to the plate would
   make them burst from empty space beside the glyph — this wrapper is what keeps
   the burst centred on what the user is actually looking at. */
.dshcombo-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

/* A skewed accent slab behind the letter: the graphic-design anchor that keeps
   the letter from floating in empty space. Bleeds past the plate on purpose. */
.dshcombo-slash {
  position: absolute;
  top: 50%;
  width: 132%;
  height: 46px;
  margin-top: -23px;
  z-index: 0;
  background: linear-gradient(90deg,
    transparent,
    color-mix(in srgb, var(--dswcombo-accent) 26%, transparent) 30%,
    color-mix(in srgb, var(--dswcombo-accent) 10%, transparent));
  transform: skewY(-14deg);
  opacity: 0.55;
}
.dshcombo-rail[data-side="you"] .dshcombo-slash { left: -8%; }
.dshcombo-rail[data-side="agent"] .dshcombo-slash {
  right: -8%;
  transform: skewY(14deg);
  background: linear-gradient(270deg,
    transparent,
    color-mix(in srgb, var(--dswcombo-accent) 26%, transparent) 30%,
    color-mix(in srgb, var(--dswcombo-accent) 10%, transparent));
}

.dshcombo-rank {
  position: relative;
  z-index: 2;
  font-weight: 900;
  font-style: italic;
  font-size: 76px;
  line-height: 0.74;
  letter-spacing: -0.075em;
  color: var(--dswcombo-accent);
  transform: skewX(-8deg);
  text-shadow:
    0 2px 0 rgba(0, 0, 0, 0.5),
    0 0 24px color-mix(in srgb, var(--dswcombo-accent) 70%, transparent);
  transition: color 240ms ease, text-shadow 240ms ease;
}
/* Letters that carry two glyphs need less size to stay inside the gutter. */
.dshcombo-rail[data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-rank="SSS"] .dshcombo-rank { font-size: 58px; letter-spacing: -0.09em; }
.dshcombo-rail[data-narrow="true"] .dshcombo-rank { font-size: 58px; }
.dshcombo-rail[data-narrow="true"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-narrow="true"][data-rank="SSS"] .dshcombo-rank { font-size: 42px; }

/* rank colours: one accent variable per rank drives letter, slash, bar, sparks */
.dshcombo-rail { --dswcombo-accent: var(--dsw-alias-state-idle-primary); }
.dshcombo-rail[data-rank="C"]    { --dswcombo-accent: #4f9cf9; }
.dshcombo-rail[data-rank="B"]    { --dswcombo-accent: #45c98a; }
.dshcombo-rail[data-rank="A"]    { --dswcombo-accent: #f5c542; }
.dshcombo-rail[data-rank="S"]    { --dswcombo-accent: #f08a2e; }
.dshcombo-rail[data-rank="SS"]   { --dswcombo-accent: #e8443a; }
.dshcombo-rail[data-rank="SSS"]  { --dswcombo-accent: #ff2d95; }
/* Above SSS the colour leaves the warm band entirely, so the top rungs read as
   a different state rather than "more orange". */
.dshcombo-rail[data-rank="SSS+"] { --dswcombo-accent: #a855f7; }
.dshcombo-rail[data-rank="V"]    { --dswcombo-accent: #22d3ee; }

/* ── horizontal charge bar, under the rank letter ──────────────────────────
   A slanted parallelogram: the skew is what gives it the angular, graphic
   look, and laying it horizontally under the glyph puts it where the eye
   already is instead of on the far edge of the gutter. It fills from the OUTER
   edge inward on each side, so the two rails mirror each other. */
.dshcombo-charge {
  position: relative;
  display: block;
  width: 100%;
  height: 10px;
  margin-top: 2px;
  transform: skewX(-18deg);
  border-radius: 1px;
  background: color-mix(in srgb, var(--dswcombo-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dswcombo-accent) 22%, transparent);
  z-index: 1;
}
.dshcombo-charge > i {
  position: absolute;
  inset: 0;
  display: block;
  transform-origin: left center;
  background: linear-gradient(90deg,
    var(--dswcombo-accent) 0%,
    color-mix(in srgb, var(--dswcombo-accent) 85%, white) 55%,
    color-mix(in srgb, var(--dswcombo-accent) 35%, transparent) 100%);
  box-shadow:
    0 0 12px var(--dswcombo-accent),
    0 0 26px color-mix(in srgb, var(--dswcombo-accent) 60%, transparent);
  transition: transform 180ms cubic-bezier(.2,.9,.3,1);
}
/* The AGENT bar fills from its outer (right) edge inward, mirroring YOU. */
.dshcombo-rail[data-side="agent"] .dshcombo-charge > i {
  transform-origin: right center;
  background: linear-gradient(270deg,
    var(--dswcombo-accent) 0%,
    color-mix(in srgb, var(--dswcombo-accent) 85%, white) 55%,
    color-mix(in srgb, var(--dswcombo-accent) 35%, transparent) 100%);
}
/* Tick marks at the rank thresholds, as vertical notches across the bar. */
.dshcombo-charge > b {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: color-mix(in srgb, var(--dswcombo-accent) 40%, transparent);
  z-index: 2;
  transition: background 180ms ease;
}
.dshcombo-charge > b[data-passed="true"] {
  background: color-mix(in srgb, var(--dswcombo-accent) 85%, white);
  box-shadow: 0 0 8px var(--dswcombo-accent);
}
/* A bright leading edge riding the fill, so the current level reads at a glance
   even without looking at the number. */
.dshcombo-charge > s {
  position: absolute;
  top: -2px;
  bottom: -2px;
  left: 0;
  width: 3px;
  background: color-mix(in srgb, var(--dswcombo-accent) 60%, white);
  box-shadow: 0 0 14px var(--dswcombo-accent), 0 0 26px var(--dswcombo-accent);
  transition: transform 180ms cubic-bezier(.2,.9,.3,1);
  z-index: 3;
}

/* ── hit: flash + sparks, all of it free to escape the rail ──────────────── */
/* Every effect below is positioned from 0/0 of its parent. The parent is the
   letter's own .dshcombo-anchor box, so left/top 50% means "the centre of the
   glyph" — not the centre of the rail. */
.dshcombo-flash {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  width: 190px;
  height: 190px;
  margin: -95px 0 0 -95px;
  border-radius: 50%;
  background: radial-gradient(circle,
    color-mix(in srgb, var(--dswcombo-accent) 90%, white) 0%,
    color-mix(in srgb, var(--dswcombo-accent) 40%, transparent) 38%,
    transparent 70%);
  animation: dshcombo-flash 360ms ease-out forwards;
}
@keyframes dshcombo-flash {
  0%   { opacity: 0.95; transform: scale(0.25); }
  100% { opacity: 0; transform: scale(2.1); }
}
.dshcombo-sparks {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 3;
}
.dshcombo-sparks > i {
  position: absolute;
  width: var(--w, 3px);
  height: var(--w, 3px);
  margin: calc(var(--w, 3px) / -2);
  border-radius: 50%;
  background: color-mix(in srgb, var(--dswcombo-accent) 80%, white);
  box-shadow: 0 0 8px var(--dswcombo-accent), 0 0 18px var(--dswcombo-accent);
  animation: dshcombo-spark var(--t, 480ms) cubic-bezier(.15,.7,.3,1) forwards;
}
@keyframes dshcombo-spark {
  0%   { opacity: 1; transform: rotate(var(--a)) translateX(6px) scale(1.1); }
  100% { opacity: 0; transform: rotate(var(--a)) translateX(var(--d, 118px)) scale(0.1); }
}

/* ── rank-up: everything here deliberately overflows the rail ────────────── */
/* Two rings. The first is wide enough to sweep across a large part of the page,
   which is the "this escaped the gutter" gesture: it is drawn from the letter's
   own box (the anchor), so it expands from the glyph, not from empty space. */
.dshcombo-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border: 3px solid var(--dswcombo-accent);
  border-radius: 50%;
  box-shadow:
    0 0 24px color-mix(in srgb, var(--dswcombo-accent) 80%, transparent),
    inset 0 0 18px color-mix(in srgb, var(--dswcombo-accent) 55%, transparent);
  animation: dshcombo-ring 760ms cubic-bezier(.1,.7,.3,1) forwards;
}
.dshcombo-ring-late {
  border-width: 1px;
  animation-duration: 1040ms;
  animation-delay: 120ms;
}
@keyframes dshcombo-ring {
  0%   { opacity: 1; transform: scale(0.2); }
  100% { opacity: 0; transform: scale(26); }
}

/* ── the big wave: a page-scale shockwave on a rank-up ──────────────────────
   A wide, soft gradient disc that expands past the conversation column. It is
   intentionally huge: the request was an effect that covers a good part of the
   page, and a ring confined to the gutter cannot read as impact. */
.dshcombo-wave {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 0;
  width: 220px;
  height: 220px;
  margin: -110px 0 0 -110px;
  border-radius: 50%;
  background: radial-gradient(circle,
    color-mix(in srgb, var(--dswcombo-accent) 42%, transparent) 0%,
    color-mix(in srgb, var(--dswcombo-accent) 16%, transparent) 46%,
    transparent 70%);
  animation: dshcombo-wave 900ms cubic-bezier(.1,.75,.25,1) forwards;
}
@keyframes dshcombo-wave {
  0%   { opacity: 0; transform: scale(0.15); }
  12%  { opacity: 1; }
  100% { opacity: 0; transform: scale(4.6); }
}

/* ── the slash: a long diagonal energy cut across the page ──────────────────
   This is the "光刃" made unmistakable: not a tiny streak, but a full-length
   blade of light that sweeps diagonally out of the letter and across the
   conversation. Two of them cross for the heavier ranks. */
.dshcombo-slashbeam {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 3;
  width: 780px;
  height: 5px;
  margin: -2.5px 0 0;
  transform-origin: 0 50%;
  border-radius: 5px;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--dswcombo-accent) 95%, white),
    var(--dswcombo-accent) 22%,
    color-mix(in srgb, var(--dswcombo-accent) 45%, transparent) 62%,
    transparent);
  filter: blur(0.4px);
  box-shadow:
    0 0 16px var(--dswcombo-accent),
    0 0 42px color-mix(in srgb, var(--dswcombo-accent) 75%, transparent);
  animation: dshcombo-slashbeam 620ms cubic-bezier(.1,.85,.2,1) forwards;
}
.dshcombo-rail[data-side="you"] .dshcombo-slashbeam { transform: rotate(-22deg); }
.dshcombo-rail[data-side="agent"] .dshcombo-slashbeam {
  left: auto;
  right: 50%;
  transform: rotate(180deg) rotate(22deg);
  transform-origin: 100% 50%;
}
/* The second blade crosses the first for a heavier cut. */
.dshcombo-slashbeam-cross {
  animation-delay: 90ms;
  animation-duration: 700ms;
  height: 3px;
}
.dshcombo-rail[data-side="you"] .dshcombo-slashbeam-cross { transform: rotate(14deg); }
.dshcombo-rail[data-side="agent"] .dshcombo-slashbeam-cross {
  transform: rotate(180deg) rotate(-14deg);
}
@keyframes dshcombo-slashbeam {
  0%   { opacity: 0; transform-origin: 0 50%; scale: 0.06 1; }
  14%  { opacity: 1; }
  62%  { opacity: 1; }
  100% { opacity: 0; scale: 1.12 0.7; }
}

/* A beam fired toward the conversation on every rank-up. */
.dshcombo-beam {
  position: absolute;
  top: 50%;
  z-index: 2;
  width: 340px;
  height: 3px;
  margin-top: -1.5px;
  animation: dshcombo-beam 500ms cubic-bezier(.1,.8,.2,1) forwards;
}
.dshcombo-rail[data-side="you"] .dshcombo-beam {
  left: 58%;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--dswcombo-accent) 90%, white),
    var(--dswcombo-accent) 16%,
    transparent);
}
.dshcombo-rail[data-side="agent"] .dshcombo-beam {
  right: 58%;
  background: linear-gradient(270deg,
    color-mix(in srgb, var(--dswcombo-accent) 90%, white),
    var(--dswcombo-accent) 16%,
    transparent);
}
@keyframes dshcombo-beam {
  0%   { opacity: 0; transform: scaleX(0.04); }
  16%  { opacity: 1; }
  100% { opacity: 0; transform: scaleX(1.5); }
}

/* 16-point burst: travels far past the gutter into the page. */
.dshcombo-burst {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 4;
}
.dshcombo-burst > i {
  position: absolute;
  width: var(--w, 4px);
  height: var(--w, 4px);
  margin: calc(var(--w, 4px) / -2);
  border-radius: 50%;
  background: color-mix(in srgb, var(--dswcombo-accent) 75%, white);
  box-shadow: 0 0 12px var(--dswcombo-accent), 0 0 30px var(--dswcombo-accent);
  animation: dshcombo-burst var(--t, 780ms) cubic-bezier(.12,.72,.28,1) forwards;
}
@keyframes dshcombo-burst {
  0%   { opacity: 0; transform: rotate(var(--a)) translateX(6px) scale(0.35); }
  12%  { opacity: 1; }
  100% { opacity: 0; transform: rotate(var(--a)) translateX(var(--d, 230px)) scale(0.12); }
}

/* Six long radial slashes, stretched hard as they fly. */
.dshcombo-streaks {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 3;
}
.dshcombo-streaks > i {
  position: absolute;
  width: 3px;
  height: 46px;
  margin: -23px -1.5px;
  border-radius: 3px;
  background: linear-gradient(180deg,
    transparent,
    var(--dswcombo-accent) 40%,
    color-mix(in srgb, var(--dswcombo-accent) 65%, white) 50%,
    var(--dswcombo-accent) 60%,
    transparent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--dswcombo-accent) 80%, transparent);
  animation: dshcombo-streak var(--t, 660ms) cubic-bezier(.1,.8,.25,1) forwards;
}
@keyframes dshcombo-streak {
  0%   { opacity: 0; transform: rotate(var(--a)) translateY(-10px) scaleY(0.2); }
  16%  { opacity: 1; }
  100% { opacity: 0; transform: rotate(var(--a)) translateY(-190px) scaleY(2.6); }
}

/* max-intensity flare: a bloom wide enough to wash the whole gutter. */
.dshcombo-flare {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 0;
  width: 420px;
  height: 420px;
  margin: -210px 0 0 -210px;
  border-radius: 50%;
  background: radial-gradient(circle,
    color-mix(in srgb, var(--dswcombo-accent) 55%, transparent) 0%,
    color-mix(in srgb, var(--dswcombo-accent) 18%, transparent) 42%,
    transparent 72%);
  animation: dshcombo-flare 720ms ease-out forwards;
}
@keyframes dshcombo-flare {
  0%   { opacity: 0; transform: scale(0.2); }
  16%  { opacity: 1; }
  100% { opacity: 0; transform: scale(2.1); }
}

/* the letter punches on every hit, and stamps harder on a rank-up */
.dshcombo-rail[data-hit="true"] .dshcombo-rank {
  animation: dshcombo-hit 260ms cubic-bezier(.2,1.5,.4,1) both;
}
@keyframes dshcombo-hit {
  0%   { transform: skewX(-8deg) translateY(4px) scale(0.82); }
  42%  { transform: skewX(-8deg) translateY(-5px) scale(1.22); }
  100% { transform: skewX(-8deg) translateY(0) scale(1); }
}
.dshcombo-rail[data-rankup="true"] .dshcombo-rank {
  animation: dshcombo-stamp 460ms cubic-bezier(.15,1.6,.3,1) both;
}
@keyframes dshcombo-stamp {
  0%   { transform: skewX(-8deg) scale(2.4); opacity: 0.15; }
  52%  { transform: skewX(-8deg) scale(0.9); opacity: 1; }
  100% { transform: skewX(-8deg) scale(1); }
}

/* ── the count: big tabular number, tight under the letter ───────────────── */
.dshcombo-count {
  position: relative;
  z-index: 2;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  font-size: 34px;
  line-height: 0.9;
  letter-spacing: -0.035em;
  color: var(--dsw-alias-label-secondary);
  transition: color 240ms ease;
}
.dshcombo-rail[data-lit="true"] .dshcombo-count { color: var(--dsw-alias-label-primary); }
.dshcombo-count[data-pop="true"] { animation: dshcombo-pop 220ms cubic-bezier(.2,1.6,.4,1) both; }
@keyframes dshcombo-pop {
  0%   { transform: scale(1.5); }
  100% { transform: scale(1); }
}

/* ── the latest move name ────────────────────────────────────────────────── */
.dshcombo-move {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.45;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dshcombo-rail[data-lit="true"] .dshcombo-move {
  color: var(--dswcombo-accent);
  opacity: 0.9;
}

/* ── intensity buckets: effects peel away as the slider drops ────────────── */
/* mid: glow appears at high ranks */
.dshcombo-rail[data-i="mid"][data-rank="S"] .dshcombo-rank,
.dshcombo-rail[data-i="mid"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-i="mid"][data-rank="SSS"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="A"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="S"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="SSS"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="A"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="S"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="SSS"] .dshcombo-rank {
  text-shadow:
    0 2px 0 rgba(0, 0, 0, 0.5),
    0 0 30px color-mix(in srgb, var(--dswcombo-accent) 95%, transparent),
    0 0 68px color-mix(in srgb, var(--dswcombo-accent) 60%, transparent);
}
/* high+: the letter breathes at S and above */
.dshcombo-rail[data-i="high"][data-rank="S"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-i="high"][data-rank="SSS"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="S"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="SS"] .dshcombo-rank,
.dshcombo-rail[data-i="max"][data-rank="SSS"] .dshcombo-rank {
  animation: dshcombo-breathe 1.6s ease-in-out infinite;
}
@keyframes dshcombo-breathe {
  0%, 100% { transform: skewX(-8deg) scale(1); }
  50%      { transform: skewX(-8deg) scale(1.09); }
}
/* max: the whole rail trembles on each hit */
.dshcombo-rail[data-i="max"][data-hit="true"] .dshcombo-inner {
  animation: dshcombo-shake 300ms linear both;
}
@keyframes dshcombo-shake {
  0%   { transform: translate(0, 0); }
  16%  { transform: translate(-3px, 1px); }
  32%  { transform: translate(3px, -2px); }
  48%  { transform: translate(-3px, -1px); }
  64%  { transform: translate(3px, 2px); }
  82%  { transform: translate(-1px, 0); }
  100% { transform: translate(0, 0); }
}
/* max + top ranks: a slow rotating energy halo.
   The previous version slid a soft band vertically, which read as a scan line
   crawling over the glyph rather than as power. A ring that turns around the
   letter reads as sustained energy, and because it rotates instead of sweeping
   it never suggests a top or bottom edge. */
.dshcombo-rail[data-i="max"][data-rank="SSS"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="high"][data-rank="SSS"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="max"][data-rank="SSS+"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="high"][data-rank="SSS+"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="max"][data-rank="V"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="high"][data-rank="V"] .dshcombo-anchor::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  width: 124px;
  height: 124px;
  margin: -62px 0 0 -62px;
  pointer-events: none;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    color-mix(in srgb, var(--dswcombo-accent) 70%, transparent) 60deg,
    color-mix(in srgb, var(--dswcombo-accent) 20%, transparent) 120deg,
    transparent 180deg,
    color-mix(in srgb, var(--dswcombo-accent) 55%, transparent) 260deg,
    transparent 340deg);
  filter: blur(6px);
  mix-blend-mode: screen;
  animation: dshcombo-halo 3.2s linear infinite;
}
/* A second, thinner ring turning the other way so the halo never looks static. */
.dshcombo-rail[data-i="max"][data-rank="SSS"] .dshcombo-anchor::before,
.dshcombo-rail[data-i="max"][data-rank="SSS+"] .dshcombo-anchor::before,
.dshcombo-rail[data-i="max"][data-rank="V"] .dshcombo-anchor::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  width: 96px;
  height: 96px;
  margin: -48px 0 0 -48px;
  pointer-events: none;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--dswcombo-accent) 45%, transparent);
  box-shadow: 0 0 20px color-mix(in srgb, var(--dswcombo-accent) 45%, transparent);
  animation: dshcombo-halo-reverse 4.6s linear infinite;
}
@keyframes dshcombo-halo {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes dshcombo-halo-reverse {
  from { transform: rotate(360deg) scale(1); }
  50%  { transform: rotate(180deg) scale(1.06); }
  to   { transform: rotate(0deg) scale(1); }
}
/* The top two rungs get a wider, faster halo and a pulsing aura, so V is
   visibly a different class of state from SSS. */
.dshcombo-rail[data-i="max"][data-rank="SSS+"] .dshcombo-anchor::after,
.dshcombo-rail[data-i="max"][data-rank="V"] .dshcombo-anchor::after {
  width: 156px;
  height: 156px;
  margin: -78px 0 0 -78px;
  animation-duration: 2.1s;
}
.dshcombo-rail[data-i="max"][data-rank="V"] .dshcombo-rank {
  animation: dshcombo-v-pulse 1.1s ease-in-out infinite;
}
@keyframes dshcombo-v-pulse {
  0%, 100% {
    transform: skewX(-8deg) scale(1);
    text-shadow: 0 2px 0 rgba(0, 0, 0, 0.5), 0 0 34px var(--dswcombo-accent);
  }
  50% {
    transform: skewX(-8deg) scale(1.1);
    text-shadow: 0 2px 0 rgba(0, 0, 0, 0.5), 0 0 58px var(--dswcombo-accent), 0 0 110px var(--dswcombo-accent);
  }
}

/* ── floating quip: one line per strike, rising and fading ────────────────── */
.dshcombo-quip {
  position: absolute;
  top: -6px;
  z-index: 6;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  white-space: nowrap;
  color: color-mix(in srgb, var(--dswcombo-accent) 65%, white);
  background: color-mix(in srgb, var(--dswcombo-accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--dswcombo-accent) 40%, transparent);
  text-shadow: 0 0 10px color-mix(in srgb, var(--dswcombo-accent) 80%, transparent);
  pointer-events: none;
  animation: dshcombo-quip-rise 900ms cubic-bezier(.2,.9,.3,1) forwards;
}
.dshcombo-rail[data-side="you"] .dshcombo-quip { left: 0; }
.dshcombo-rail[data-side="agent"] .dshcombo-quip { right: 0; }
/* A rank-up quip is louder and tinted differently from a plain hit. */
.dshcombo-quip[data-kind="rankup"] {
  font-size: 12px;
  padding: 3px 8px;
  color: #fff;
  background: color-mix(in srgb, var(--dswcombo-accent) 55%, transparent);
  border-color: color-mix(in srgb, var(--dswcombo-accent) 85%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--dswcombo-accent) 70%, transparent);
  animation-duration: 1100ms;
}
@keyframes dshcombo-quip-rise {
  0%   { opacity: 0; transform: translateY(6px) scale(0.85); }
  16%  { opacity: 1; transform: translateY(0) scale(1.06); }
  32%  { transform: translateY(-2px) scale(1); }
  100% { opacity: 0; transform: translateY(-44px) scale(0.96); }
}

/* ── stats strip: the measured numbers, stacked under the rail ────────────── */
.dshcombo-stats {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  width: 100%;
}
.dshcombo-rail[data-side="agent"] .dshcombo-stats { align-items: flex-end; }
.dshcombo-stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  line-height: 15px;
  white-space: nowrap;
}
.dshcombo-stat > em {
  font-style: normal;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.5;
}
.dshcombo-stat > b {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
  transition: color 200ms ease;
}
.dshcombo-rail[data-lit="true"] .dshcombo-stat > b {
  color: color-mix(in srgb, var(--dswcombo-accent) 55%, var(--dsw-alias-label-primary));
}

/* ── rank-scaled effects ───────────────────────────────────────────────────
   Two custom properties drive the size of everything here:
     --scale  the rank size multiplier for ordinary strikes,
     --up     the multiplier for rank-up / surge bursts.
   Sizing every layer from one multiplier is what makes the ranks actually look
   different; changing only the particle count made them read as "the same
   effect, denser". */

/* The strike flash scales with the rank. */
.dshcombo-flash {
  transform: scale(var(--scale, 1));
}
.dshcombo-flash[data-big="true"] {
  width: 260px;
  height: 260px;
  margin: -130px 0 0 -130px;
}
.dshcombo-rail[data-tier="6"] .dshcombo-flash,
.dshcombo-rail[data-tier="7"] .dshcombo-flash,
.dshcombo-rail[data-tier="8"] .dshcombo-flash {
  filter: brightness(1.35);
}

/* Rings: width, border and expansion all ride --up. */
.dshcombo-ring {
  width: calc(30px * var(--up, 1));
  height: calc(30px * var(--up, 1));
  margin: calc(-15px * var(--up, 1)) 0 0 calc(-15px * var(--up, 1));
  border-width: calc(3px * var(--up, 1));
}
.dshcombo-ring[data-tier="4"],
.dshcombo-ring[data-tier="5"] { border-width: 4px; }
.dshcombo-ring[data-tier="6"],
.dshcombo-ring[data-tier="7"],
.dshcombo-ring[data-tier="8"] {
  border-width: 5px;
  box-shadow:
    0 0 34px color-mix(in srgb, var(--dswcombo-accent) 90%, transparent),
    inset 0 0 26px color-mix(in srgb, var(--dswcombo-accent) 65%, transparent);
}
/* A third ring, slower and thinner, only at the top ranks. */
.dshcombo-ring-third {
  border-width: 1px;
  animation-duration: 1200ms;
  animation-delay: 210ms;
}

/* Energy cuts: length, thickness and glow all scale. */
.dshcombo-slashbeam {
  width: calc(780px * var(--up, 1));
  height: calc(5px * var(--up, 1));
  margin-top: calc(-2.5px * var(--up, 1));
}
.dshcombo-slashbeam[data-tier="4"],
.dshcombo-slashbeam[data-tier="5"] { width: 940px; height: 6px; }
.dshcombo-slashbeam[data-tier="6"],
.dshcombo-slashbeam[data-tier="7"],
.dshcombo-slashbeam[data-tier="8"] {
  width: 1180px;
  height: 8px;
  filter: blur(0.2px);
  box-shadow:
    0 0 26px var(--dswcombo-accent),
    0 0 70px color-mix(in srgb, var(--dswcombo-accent) 85%, transparent);
}
/* The third cut sits between the other two angles for a fuller fan. */
.dshcombo-rail[data-side="you"] .dshcombo-slashbeam-third { transform: rotate(-4deg); }
.dshcombo-rail[data-side="agent"] .dshcombo-slashbeam-third {
  transform: rotate(180deg) rotate(4deg);
}

/* The forward beam thickens with the rank. */
.dshcombo-beam {
  width: calc(340px * var(--up, 1));
  height: calc(3px * var(--up, 1));
  margin-top: calc(-1.5px * var(--up, 1));
}
.dshcombo-beam[data-tier="4"],
.dshcombo-beam[data-tier="5"] { height: 4px; width: 420px; }
.dshcombo-beam[data-tier="6"],
.dshcombo-beam[data-tier="7"],
.dshcombo-beam[data-tier="8"] {
  height: 6px;
  width: 520px;
  box-shadow: 0 0 24px var(--dswcombo-accent);
}

/* The page wave scales with --up. */
.dshcombo-wave {
  width: calc(220px * var(--up, 1));
  height: calc(220px * var(--up, 1));
  margin: calc(-110px * var(--up, 1)) 0 0 calc(-110px * var(--up, 1));
}
.dshcombo-wave[data-tier="4"],
.dshcombo-wave[data-tier="5"] { width: 320px; height: 320px; margin: -160px 0 0 -160px; }
.dshcombo-wave[data-tier="6"],
.dshcombo-wave[data-tier="7"],
.dshcombo-wave[data-tier="8"] {
  width: 440px;
  height: 440px;
  margin: -220px 0 0 -220px;
  animation-duration: 1050ms;
}

/* A second particle wave, offset in time, from S upward. */
.dshcombo-burst-late {
  animation-delay: 140ms;
  z-index: 5;
}

/* The flare scales with --up. */
.dshcombo-flare {
  width: calc(420px * var(--up, 1));
  height: calc(420px * var(--up, 1));
  margin: calc(-210px * var(--up, 1)) 0 0 calc(-210px * var(--up, 1));
}
.dshcombo-flare[data-tier="6"],
.dshcombo-flare[data-tier="7"],
.dshcombo-flare[data-tier="8"] {
  width: 620px;
  height: 620px;
  margin: -310px 0 0 -310px;
}

/* Particle glow rides the per-particle --g the builder emits. */
.dshcombo-sparks > i {
  box-shadow: 0 0 var(--g, 8px) var(--dswcombo-accent), 0 0 calc(var(--g, 8px) * 2) var(--dswcombo-accent);
}
.dshcombo-burst > i {
  box-shadow: 0 0 var(--g, 10px) var(--dswcombo-accent), 0 0 calc(var(--g, 10px) * 2.4) var(--dswcombo-accent);
}

/* At the top tiers the whole rail gains a persistent aura, so the HUD itself
   looks hotter while the combo is high rather than only on a strike. */
.dshcombo-rail[data-tier="6"] .dshcombo-rank,
.dshcombo-rail[data-tier="7"] .dshcombo-rank,
.dshcombo-rail[data-tier="8"] .dshcombo-rank {
  text-shadow:
    0 2px 0 rgba(0, 0, 0, 0.5),
    0 0 34px color-mix(in srgb, var(--dswcombo-accent) 95%, transparent),
    0 0 78px color-mix(in srgb, var(--dswcombo-accent) 70%, transparent);
}
/* The charge column burns brighter at the top tiers too. */
.dshcombo-rail[data-tier="6"] .dshcombo-charge > i,
.dshcombo-rail[data-tier="7"] .dshcombo-charge > i,
.dshcombo-rail[data-tier="8"] .dshcombo-charge > i {
  box-shadow:
    0 0 18px var(--dswcombo-accent),
    0 0 44px color-mix(in srgb, var(--dswcombo-accent) 75%, transparent),
    inset 0 0 10px color-mix(in srgb, var(--dswcombo-accent) 85%, white);
}

/* ── overflow counter: the reward for pushing past the final rank ─────────── */
.dshcombo-overflow {
  position: relative;
  z-index: 2;
  font-variant-numeric: tabular-nums;
  font-weight: 900;
  font-size: 14px;
  line-height: 1;
  letter-spacing: -0.02em;
  color: color-mix(in srgb, var(--dswcombo-accent) 60%, white);
  text-shadow: 0 0 14px var(--dswcombo-accent);
  animation: dshcombo-overflow-pop 320ms cubic-bezier(.2,1.6,.4,1) both;
}
.dshcombo-overflow[data-pop="true"] {
  animation: dshcombo-overflow-pop 320ms cubic-bezier(.2,1.6,.4,1) both;
}
@keyframes dshcombo-overflow-pop {
  0%   { opacity: 0; transform: translateY(4px) scale(0.7); }
  40%  { opacity: 1; transform: translateY(-2px) scale(1.35); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

/* ── capped-lane surge: rank-up effects reused on every strike ──────────────
   At V there is no next rung, so each strike borrows the rank-up stack at a
   reduced scale. The surge attribute marks those borrowed layers, keeping them
   distinct from a genuine promotion. */
.dshcombo-wave[data-surge="true"] { animation-duration: 620ms; opacity: 0.55; }
.dshcombo-ring[data-surge="true"] { animation-duration: 480ms; border-width: 2px; opacity: 0.8; }
.dshcombo-slashbeam[data-surge="true"] { animation-duration: 420ms; height: 3px; opacity: 0.7; }
.dshcombo-beam[data-surge="true"] { animation-duration: 340ms; opacity: 0.65; }
.dshcombo-flare[data-surge="true"] { animation-duration: 420ms; opacity: 0.5; }

/* The letter keeps a permanent slow throb while capped, so V reads as a state
   rather than a momentary peak. */
.dshcombo-rail[data-capped="true"] .dshcombo-rank {
  animation: dshcombo-capped-throb 2.2s ease-in-out infinite;
}
@keyframes dshcombo-capped-throb {
  0%, 100% {
    transform: skewX(-8deg) scale(1);
    filter: brightness(1);
  }
  50% {
    transform: skewX(-8deg) scale(1.06);
    filter: brightness(1.3);
  }
}

/* ── break: the letter itself shatters ─────────────────────────────────────
   The real glyph is hidden while the break plays and five clipped copies of it
   fly apart. Copying the glyph (rather than drawing abstract particles) is what
   makes it read as the letter breaking instead of a decoration next to it. */
.dshcombo-break {
  position: absolute;
  inset: 0;
  z-index: 8;
  pointer-events: none;
}
/* Each shard is a slice of the letter box holding a full copy of the glyph, so
   the slices reassemble into the letter before they fly apart. */
/* Shards clear out fast: the whole point is that the NEW rank becomes readable
   almost immediately, so they must not linger over the returning glyph. */
.dshcombo-shard {
  position: absolute;
  overflow: hidden;
  animation: dshcombo-shard 520ms cubic-bezier(.25,.6,.35,1) forwards;
  animation-delay: var(--delay, 0ms);
}
.dshcombo-shard-glyph {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-weight: 900;
  font-style: italic;
  font-size: 76px;
  line-height: 0.74;
  letter-spacing: -0.075em;
  color: #9aa2b0;
  white-space: nowrap;
  /* Dimmed and desaturated: what breaks is already dead. */
  filter: grayscale(1) brightness(0.85);
}
.dshcombo-rail[data-rank="SS"] .dshcombo-shard-glyph,
.dshcombo-rail[data-rank="SSS"] .dshcombo-shard-glyph { font-size: 58px; letter-spacing: -0.09em; }
.dshcombo-rail[data-narrow="true"] .dshcombo-shard-glyph { font-size: 58px; }
.dshcombo-rail[data-narrow="true"][data-rank="SS"] .dshcombo-shard-glyph,
.dshcombo-rail[data-narrow="true"][data-rank="SSS"] .dshcombo-shard-glyph { font-size: 42px; }

@keyframes dshcombo-shard {
  0% {
    opacity: 1;
    transform: translate(0, 0) rotate(0deg);
  }
  14% {
    /* A brief shove outward first: the crack opening. */
    opacity: 1;
    transform: translate(calc(var(--dx) * 0.22), calc(var(--dy) * 0.22)) rotate(calc(var(--rot) * 0.25));
  }
  46% {
    /* Already mostly gone: the returning glyph needs the space, so the shards
       clear out early rather than lingering over the new rank. */
    opacity: 0.45;
    transform: translate(calc(var(--dx) * 0.7), calc(var(--dy) * 0.7)) rotate(calc(var(--rot) * 0.75));
  }
  100% {
    opacity: 0;
    transform: translate(var(--dx), var(--dy)) rotate(var(--rot));
  }
}

/* The label under the shattered letter. */
.dshcombo-break-label {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  margin-top: 46px;
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.18em;
  white-space: nowrap;
  color: #c8cdd6;
  background: rgba(20, 22, 28, 0.72);
  border: 1px solid rgba(139, 147, 161, 0.5);
  animation: dshcombo-break-label 1000ms ease-out forwards;
}
@keyframes dshcombo-break-label {
  0%   { opacity: 0; transform: translate(-50%, -50%) translateY(-4px) scale(0.8); }
  14%  { opacity: 1; transform: translate(-50%, -50%) translateY(0) scale(1.06); }
  72%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -50%) translateY(6px) scale(1); }
}

/* While broken the real glyph is hidden only for the instant the shards are
   still whole. It then returns with a settle animation, so the NEW rank is
   readable immediately instead of waiting out the whole break window — the
   shards show what was lost, the returned glyph shows what you are left with. */
.dshcombo-rail[data-broken="true"] .dshcombo-rank {
  animation: dshcombo-rank-reveal 340ms cubic-bezier(.2,.9,.3,1) both;
}
@keyframes dshcombo-rank-reveal {
  0%   { opacity: 0; transform: skewX(-8deg) scale(0.62); filter: grayscale(1) brightness(0.6); }
  34%  { opacity: 1; transform: skewX(-8deg) scale(1.14); filter: grayscale(1) brightness(0.9); }
  100% { opacity: 1; transform: skewX(-8deg) scale(1); filter: none; }
}
/* The charge bar dims at the same moment. */
.dshcombo-rail[data-broken="true"] .dshcombo-charge > i {
  animation: dshcombo-charge-drop 700ms ease-in forwards;
}
@keyframes dshcombo-charge-drop {
  0%   { opacity: 1; }
  100% { opacity: 0.12; }
}

/* ── move log: a sequence of recent tool names ────────────────────────────── */
.dshcombo-moves {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 5px;
  max-width: 100%;
  margin-top: 2px;
}
.dshcombo-moves > i {
  font-style: normal;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.4;
  max-width: 62px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  transition: opacity 180ms ease, color 180ms ease;
}
/* Older entries fade; the newest one is the one the eye should land on. */
.dshcombo-moves > i[data-latest="true"] {
  opacity: 1;
  color: var(--dswcombo-accent);
}
.dshcombo-rail[data-lit="true"] .dshcombo-moves > i { opacity: 0.62; }
.dshcombo-rail[data-lit="true"] .dshcombo-moves > i[data-latest="true"] { opacity: 1; }

/* ── personal best: the record this run is measured against ──────────────── */
.dshcombo-best {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 3px;
  font-size: 9px;
  line-height: 12px;
  white-space: nowrap;
  opacity: 0.55;
  transition: opacity 220ms ease;
}
.dshcombo-best > em {
  font-style: normal;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
}
.dshcombo-best > b {
  font-weight: 800;
  font-style: italic;
  color: var(--dsw-alias-label-secondary);
}
.dshcombo-best > i {
  font-style: normal;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.8;
}
/* A new record flares: this is the one moment the stored value changes. */
.dshcombo-best[data-fresh="true"] {
  opacity: 1;
  animation: dshcombo-best-flare 1600ms cubic-bezier(.2,.9,.3,1) both;
}
.dshcombo-best[data-fresh="true"] > b,
.dshcombo-best[data-fresh="true"] > i,
.dshcombo-best[data-fresh="true"] > em {
  color: color-mix(in srgb, var(--dswcombo-accent) 70%, white);
  text-shadow: 0 0 12px var(--dswcombo-accent);
}
@keyframes dshcombo-best-flare {
  0%   { opacity: 0.55; transform: translateY(2px) scale(0.94); }
  16%  { opacity: 1; transform: translateY(0) scale(1.1); }
  70%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0.55; transform: scale(1); }
}

/* Crash fallback. Only shown if the rails throw: the error boundary renders this
   instead of blanking the slot, so a failure is visible and reportable rather
   than looking like the plugin vanished. */
.dshcombo-fallback {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 92vw;
  padding: 3px 7px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-state-error-primary);
  font-size: 10px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0.9;
}

/* ── settings row ── */
.dshcombo-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshcombo-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dshcombo-row-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshcombo-row-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dshcombo-row-controls { display: flex; align-items: center; gap: 10px; flex: none; }
/* Compact labelled toggles for the two content switches. */
.dshcombo-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dshcombo-toggle-label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dshcombo-switch-sm {
  width: 28px;
  height: 16px;
}
.dshcombo-switch-sm::after {
  width: 10px;
  height: 10px;
}
.dshcombo-switch-sm[aria-checked="true"]::after { transform: translateX(12px); }
.dshcombo-row-value {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 30px;
  text-align: right;
}
.dshcombo-slider {
  width: 140px;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dshcombo-switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  cursor: pointer;
  padding: 0;
  flex: none;
}
.dshcombo-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary);
  transition: transform 140ms ease, background 140ms ease;
}
.dshcombo-switch[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dshcombo-switch[aria-checked="true"]::after {
  transform: translateX(14px);
  background: var(--dsw-alias-bg-base);
}
`;

    /**
     * Choose the intensity bucket used by the stylesheet.
     * @param intensity - 0..100 slider value.
     * @returns a bucket name.
     */
    function bucketOf(intensity) {
      if (intensity >= 85) return 'max';
      if (intensity >= 60) return 'high';
      if (intensity >= 35) return 'mid';
      return 'low';
    }

    /**
     * Component-local stylesheet: React mounts it with the component and removes
     * it on unmount, so no global registration or disposal is needed.
     */
    function Styles() {
      return h('style', null, CSS);
    }

    // ── geometry ───────────────────────────────────────────────────────────
    /**
     * Measure where the conversation content column sits inside its centre
     * frame, in viewport coordinates.
     *
     * Nothing here depends on a host class name or `data-` attribute: the frame
     * is found by walking up from the probe's own anchor and taking the nearest
     * ancestor that is a flex/grid column taller than the composer (the
     * conversation body). The content column edges come from the host's own
     * published width variable when it resolves, and otherwise from the
     * composer card the probe lives in.
     *
     * Only layout rectangles are read; no markup, text, or styles are modified.
     *
     * @param anchor - the probe's in-flow marker element.
     * @returns viewport-space edges, or null when the layout is not measurable.
     */
    function measureGeometry(anchor) {
      const anchorRect = anchor.getBoundingClientRect();
      if (anchorRect.width <= 0) return null;

      // The anchor IS the centre frame. It is the full-width composer dock, so its
      // left edge is the sidebar's right edge and its right edge is the right
      // panel's left edge. Walking up to a wider ancestor is wrong here: the next
      // wider box is the whole application frame, which includes the sidebar, and
      // using it puts the left rail on top of the sidebar (the bug this replaces).
      const frameRect = anchorRect;

      // The content column is centred in the frame; take its width from the host's
      // own variable so the rails hug the real column rather than the dock.
      const columnWidth = readContentWidth(anchor, frameRect.width);
      const columnCenter = (frameRect.left + frameRect.right) / 2;
      const result = {
        columnLeft: columnCenter - columnWidth / 2,
        columnRight: columnCenter + columnWidth / 2,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
      };
      // Keep the last measurement for diagnostics: `window.__dshCombo.geometry()`
      // reports it, so a placement problem can still be inspected from the
      // console without a visible debug surface in the product.
      publishDiagnostics({
        ...result,
        anchorLeft: anchorRect.left,
        anchorWidth: anchorRect.width,
        frameWidth: frameRect.width,
        columnWidth,
        viewport: window.innerWidth,
      });
      return result;
    }

    /**
     * Expose the latest measurement on a namespaced global for console debugging.
     * Deliberately not rendered: the shipped HUD carries no debug chrome.
     * @param snapshot - viewport-space measurement plus its inputs.
     */
    function publishDiagnostics(snapshot) {
      const target = window.__dshCombo = window.__dshCombo ?? {};
      target.geometry = () => ({ ...snapshot });
      target.build = BUILD;
    }

    /**
     * Resolve the conversation content-column width.
     *
     * The host publishes `--dsh-chat-content-width` on the conversation body, an
     * ancestor of the composer. Walk up from the anchor looking for the first
     * element that resolves it; the value is inherited, so the nearest one that
     * yields a positive length is the effective column width.
     *
     * When no variable resolves (a different host build), fall back to the
     * host's own default formula for the column so placement stays sane:
     * `clamp(680px, frame * 0.64, 920px)`.
     *
     * @param anchor - the probe's in-flow marker element.
     * @param frameWidth - measured centre-frame width, used by the fallback.
     * @returns width in px.
     */
    function readContentWidth(anchor, frameWidth) {
      let element = anchor;
      let depth = 0;
      while (element !== null && element !== undefined && depth < 24) {
        const raw = window.getComputedStyle(element).getPropertyValue('--dsh-chat-content-width');
        const value = Number.parseFloat(raw);
        if (Number.isFinite(value) && value > 0) return value;
        element = element.parentElement;
        depth += 1;
      }
      return Math.min(920, Math.max(680, frameWidth * 0.64));
    }

    // ── PROBE: state machines + geometry ───────────────────────────────────
    /**
     * Runs both combo lanes and publishes them, plus where the composer column
     * sits, for the rails. Renders a zero-height marker only.
     * @param props - session slot props.
     */
    function ComboProbe(props) {
      const { useInput, useChat, useSessionStatus, useProjection, sessionId } = props;

      const draft = useInput((st) => st.draft);
      const running = useSessionStatus((snapshot) => (
        sessionId === undefined ? false : snapshot.get(sessionId)?.running === true
      ));
      const nodes = useChat((st) => st.legacy.nodes);
      // Token accounting and decode timing ride the durable whole-log projections;
      // both may be absent in a lean profile, so every read is defensive.
      const usage = useProjection === undefined ? undefined : useProjection('tokenUsage');
      const stats = useProjection === undefined ? undefined : useProjection('sessionStats');

      const anchorRef = React.useRef(null);

      // All mutable combo state in one ref: the effects below only need to
      // publish, never to read stale closures.
      const state = React.useRef({
        userHits: 0,
        userLast: 0,
        userFrozen: 0,
        agentHits: 0,
        agentLast: 0,
        agentFrozen: 0,
        userHitAt: 0,
        agentHitAt: 0,
        userBreakAt: 0,
        agentBreakAt: 0,
        userBreakRank: '',
        agentBreakRank: '',
        // Highest rank each lane reached during the current run. The break effect
        // reports this, because the value at the moment of collapse is always D.
        userPeak: 'D',
        agentPeak: 'D',
        lastMove: '',
        /** Recent distinct tool names, newest last; see MOVE_LOG_MAX. */
        moveLog: [],
        prevLen: typeof draft === 'string' ? draft.length : 0,
        processed: new Set(),
        wasRunning: running,
        /** Typing-rate window: recent (time, length) samples, pruned to WINDOW_MS. */
        keystrokeSamples: [],
      });

      /** Push the current lane values to the store. */
      const flush = React.useCallback(() => {
        const st = state.current;
        store.publish({
          userHits: st.userHits,
          userFrozen: st.userFrozen,
          agentHits: st.agentHits,
          agentFrozen: st.agentFrozen,
          lastMove: st.lastMove,
          moveLog: st.moveLog.slice(),
          running: st.wasRunning,
          userHitAt: st.userHitAt,
          agentHitAt: st.agentHitAt,
          userBreakAt: st.userBreakAt,
          agentBreakAt: st.agentBreakAt,
          userBreakRank: st.userBreakRank,
          agentBreakRank: st.agentBreakRank,
          userPeak: st.userPeak,
          agentPeak: st.agentPeak,
          live: true,
        });
      }, []);

      /**
       * Record that a lane lost its combo.
       *
       * A lane drains gradually, so the value at the moment it reaches zero is
       * always ~0 and always ranks as D. Using that value meant the break never
       * fired for any lane that decayed — the earlier version checked the value
       * at zero, which is by definition worthless. The meaningful figure is the
       * PEAK the lane reached during this run, which is what the player actually
       * loses; each lane tracks it as `peak`.
       *
       * @param lane - 'user' or 'agent'.
       */
      const recordBreak = React.useCallback((lane) => {
        const st = state.current;
        const peak = lane === 'user' ? st.userPeak : st.agentPeak;
        // Nothing of value was lost: stay quiet rather than crying wolf on every
        // pause that never built a combo in the first place.
        if (rankIndex(peak) <= 0) return;
        const at = Date.now();
        if (lane === 'user') {
          st.userBreakAt = at;
          st.userBreakRank = peak;
          st.userPeak = 'D';
        } else {
          st.agentBreakAt = at;
          st.agentBreakRank = peak;
          st.agentPeak = 'D';
        }
      }, []);

      // Geometry: publish where the centre column and its content column sit.
      React.useEffect(() => {
        let frame = 0;
        const sync = () => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            const anchor = anchorRef.current;
            if (anchor === null) return;
            const geometry = measureGeometry(anchor);
            if (geometry === null) return;
            store.publishGeometry(geometry);
          });
        };
        sync();
        window.addEventListener('resize', sync);
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined;
        if (observer !== undefined) {
          observer.observe(document.body);
          if (anchorRef.current !== null) observer.observe(anchorRef.current);
        }
        return () => {
          window.removeEventListener('resize', sync);
          if (frame !== 0) window.cancelAnimationFrame(frame);
          observer?.disconnect();
          store.publish({ live: false });
        };
      }, []);

      // YOU: every newly typed character is a hit; clearing the draft hands the
      // achieved number over as a frozen value until the next turn settles.
      // The same sample also feeds the typing-rate window.
      React.useEffect(() => {
        const st = state.current;
        const len = typeof draft === 'string' ? draft.length : 0;
        const delta = len - st.prevLen;
        st.prevLen = len;
        const now = Date.now();
        if (delta > 0) {
          st.userFrozen = 0;
          st.userHits += delta;
          st.userLast = now;
          st.userHitAt = now;
          // Track the run's peak so a later break can report what was lost: the
          // value at the moment of collapse is always D.
          const reached = rankOf(st.userHits, USER_LADDER);
          if (rankIndex(reached) > rankIndex(st.userPeak)) st.userPeak = reached;
          // Keep a short window of typed-character samples so the displayed rate
          // reflects the last couple of seconds, not the whole session.
          st.keystrokeSamples.push({ at: now, chars: delta });
          const cutoff = now - CPS_WINDOW_MS;
          while (st.keystrokeSamples.length > 0 && st.keystrokeSamples[0].at < cutoff) {
            st.keystrokeSamples.shift();
          }
          const typed = st.keystrokeSamples.reduce((sum, sample) => sum + sample.chars, 0);
          const span = Math.max(CPS_MIN_SPAN_MS, now - st.keystrokeSamples[0].at);
          store.publishMetrics({ cps: (typed / span) * 1000 });
          flush();
        } else if (len === 0 && st.userHits > 0) {
          st.userFrozen = st.userHits;
          st.userHits = 0;
          st.userLast = 0;
          st.keystrokeSamples.length = 0;
          store.publishMetrics({ cps: 0 });
          flush();
        }
      }, [draft, flush]);

      // Token read-outs: output speed from the decode timing the session stats
      // projection already folds, and the live context size from token usage.
      // Both are display-only, so a missing projection simply leaves the value at
      // zero instead of failing the lane.
      React.useEffect(() => {
        const next = {};
        if (stats !== undefined && stats !== null) {
          const decodeMs = Number(stats.decodeMs);
          const decodeTokens = Number(stats.decodeTokens);
          if (Number.isFinite(decodeMs) && decodeMs > 0 && Number.isFinite(decodeTokens)) {
            next.tps = (decodeTokens / decodeMs) * 1000;
          }
        }
        if (usage !== undefined && usage !== null) {
          const total = Number(usage.totalTokens);
          if (Number.isFinite(total) && total >= 0) next.context = total;
        }
        if (Object.keys(next).length > 0) store.publishMetrics(next);
      }, [usage, stats]);

      // Turn boundaries. A new running turn starts the AGENT lane clean; when a
      // turn ends its achieved rank is FROZEN rather than zeroed, so the result
      // of a good run stays readable until the next turn begins.
      React.useEffect(() => {
        const st = state.current;
        if (running && !st.wasRunning) {
          st.agentHits = 0;
          st.agentLast = 0;
          st.agentFrozen = 0;
          st.agentPeak = 'D';
          st.lastMove = '';
          st.moveLog = [];
        }
        if (!running && st.wasRunning) {
          st.agentFrozen = st.agentHits;
          st.agentHits = 0;
          st.agentLast = 0;
          st.agentPeak = 'D';
          st.userFrozen = 0;
        }
        st.wasRunning = running;
        flush();
      }, [running, flush]);

      // AGENT: each newly settled Tool call is a hit; a failure or a turn error
      // breaks the chain. De-duplication is by session seq.
      React.useEffect(() => {
        const st = state.current;
        if (!Array.isArray(nodes)) return;
        let changed = false;
        for (const node of nodes) {
          if (node === null || typeof node !== 'object') continue;
          const kind = node.kind;
          if (kind !== 'tool-result' && kind !== 'turn-error') continue;
          const key = node.seq !== undefined ? node.seq : node.callId;
          if (key === undefined || st.processed.has(key)) continue;
          st.processed.add(key);
          if (kind === 'turn-error' || node.isError === true) {
            recordBreak('agent');
            st.agentHits = 0;
            st.agentLast = 0;
          } else {
            st.agentHits += 1;
            st.agentLast = Date.now();
            st.agentHitAt = Date.now();
            // Same peak tracking as the YOU lane.
            const reached = rankOf(st.agentHits, AGENT_LADDER);
            if (rankIndex(reached) > rankIndex(st.agentPeak)) st.agentPeak = reached;
            if (typeof node.name === 'string' && node.name !== '') {
              st.lastMove = node.name;
              // Keep the last few distinct moves so the lane can show a combo
              // string instead of a single name. Repeats collapse, because seeing
              // "read read read" adds nothing over "read".
              if (st.moveLog[st.moveLog.length - 1] !== node.name) {
                st.moveLog.push(node.name);
                if (st.moveLog.length > MOVE_LOG_MAX) st.moveLog.shift();
              }
            }
          }
          changed = true;
        }
        if (st.processed.size > PROCESSED_CAP) st.processed = new Set();
        if (changed) flush();
      }, [nodes, flush, recordBreak]);

      // Decay, strike-marker expiry, and the smooth YOU drain.
      //
      // The YOU lane drains continuously instead of snapping to zero. Because the
      // rank is derived from the running total, crossing a rung while draining
      // makes the lower rank's bar appear full and start emptying again — that is
      // the "drop one rank, refill, keep draining" feel, and it falls out of the
      // model rather than being special-cased.
      React.useEffect(() => {
        let lastTick = Date.now();
        const id = window.setInterval(() => {
          const st = state.current;
          const now = Date.now();
          const elapsed = Math.max(0, (now - lastTick) / 1000);
          lastTick = now;
          let changed = false;

          if (st.userHits > 0 && now - st.userLast > USER_IDLE_MS) {
            st.userHits = Math.max(0, st.userHits - USER_DECAY_PER_SEC * elapsed);
            // The drain reaching zero is the moment the combo is actually lost.
            if (st.userHits === 0) recordBreak('user');
            changed = true;
          }
          if (st.agentHits > 0 && now - st.agentLast > AGENT_IDLE_MS) {
            recordBreak('agent');
            st.agentHits = 0;
            changed = true;
          }
          if (st.userHitAt > 0 && now - st.userHitAt >= HIT_MS) {
            st.userHitAt = 0;
            changed = true;
          }
          if (st.agentHitAt > 0 && now - st.agentHitAt >= HIT_MS) {
            st.agentHitAt = 0;
            changed = true;
          }
          if (changed) flush();
        }, TICK_MS);
        return () => window.clearInterval(id);
      }, [flush, recordBreak]);

      // In-flow, zero-height: its rectangle is the composer column.
      return h('div', { ref: anchorRef, className: 'dshcombo-probe', 'aria-hidden': 'true' });
    }

    // ── RAILS: the visible half ────────────────────────────────────────────
    /**
     * Evenly spaced emission angles for a spark ring of any size. Higher ranks
     * throw more sparks, so the ring is generated instead of fixed.
     * @param count - how many sparks to emit.
     * @returns angles in degrees.
     */
    function sparkAngles(count) {
      const angles = [];
      for (let i = 0; i < count; i += 1) angles.push((360 / count) * i);
      return angles;
    }
    /** Rank-up burst: a denser two-ring explosion with varied speeds. */
    const BURST_ANGLES = [0, 22, 45, 67, 90, 112, 135, 157, 180, 202, 225, 247, 270, 292, 315, 337];
    /** Streaks that fly outward on a rank-up, longer and thinner than sparks. */
    const STREAK_ANGLES = [0, 60, 120, 180, 240, 300];

    /**
     * Build one particle layer.
     *
     * Every dimension scales with the rank: distance, size and glow all grow, so
     * a V-tier strike is visibly a different size of event from a C-tier one
     * rather than merely a different count. Scaling count alone was the earlier
     * mistake — more dots of the same size read as "the same effect, denser".
     *
     * @param className - css class for the layer.
     * @param angles - emission angles in degrees.
     * @param key - remount key so the animation restarts per event.
     * @param extra - distance, duration, size scale and thickness.
     * @returns a rendered layer element.
     */
    function particles(className, angles, key, extra) {
      const baseDistance = extra?.distance ?? 46;
      const baseDuration = extra?.duration ?? 480;
      const scale = extra?.scale ?? 1;
      const size = extra?.size ?? 2;
      return h(
        'div',
        { className, key },
        angles.map((angle, index) => h('i', {
          key: angle,
          style: {
            '--a': `${angle}deg`,
            // Deterministic variation so a burst looks hand-scattered but never
            // flickers between renders.
            '--d': `${(baseDistance + (index % 4) * 7 * scale) * scale}px`,
            '--w': `${(size + (index % 3)) * scale}px`,
            '--t': `${baseDuration + (index % 3) * 60}ms`,
            // Glow radius travels with the particle size.
            '--g': `${(8 + (index % 3) * 4) * scale}px`,
          },
        })),
      );
    }

    /**
     * Render one rail: label, rank plate, count, charge bar and latest move.
     *
     * Each hit remounts the flash and spark layer (keyed by `pulse`) so the CSS
     * animations restart instead of latching. A rank-up adds a shockwave ring,
     * a second expanding ring, a dense particle burst and flying streaks.
     *
     * @param props - side identity plus the values to show.
     */
    function Rail(props) {
      const {
        side, label, hits, rank, charge, move, lit, hit, rankup, rankupPulse,
        bucket, pulse, left, width, narrow, quip, quipKey, stats, ladderTop,
        breakAt, breakRank, downAt, downRank, best, bestFresh,
      } = props;
      // Default to an empty log: the YOU lane has no tool names, and a missing
      // prop must never crash the whole rail.
      const moveLog = Array.isArray(props.moveLog) ? props.moveLog : [];
      const style = side === 'you' ? { left, width } : { right: left, width };
      /**
       * Two independent dials decide how loud a strike is:
       *
       *   bucket — the user's effect-intensity slider (taste: how much they want
       *            to see at all),
       *   tier   — the current rank (achievement: how far the combo has climbed).
       *
       * They multiply, so a high rank at a modest slider still feels heavier than
       * a low rank at the same slider. Gating on the slider alone made V look
       * identical to D, which defeats the point of a rank ladder.
       */
      const rich = bucket === 'high' || bucket === 'max';
      /** Rank tier 0..8: how elaborate the strike effects are. */
      const tier = rankIndex(rank);
      /** Tier 4+ (S and above): extra particle rings and a wider bloom. */
      const blazing = tier >= 4;
      /** Tier 6+ (SSS and above): the heaviest layer. */
      const ascendant = tier >= 6;
      /**
       * Tier 8 (V): the ladder is capped. There is no next rank to climb toward,
       * so the reward has to change shape: every single strike fires a scaled-down
       * rank-up burst, and the lane shows how far past the cap it has pushed. This
       * is the "still gaining something at max" feedback.
       */
      const capped = tier >= rankCount() - 1;
      /** Whether this strike should borrow the rank-up burst treatment. */
      const surge = rankup || (capped && hit);
      /**
       * A capped lane counts upward past its final rung. `overflow` is the number
       * of strikes beyond the cap; the caller passes the raw hit count, so this is
       * simply hits minus the final threshold.
       */
      const overflow = capped ? Math.max(0, Math.floor(hits - ladderTop)) : 0;

      /**
       * Master size multiplier for every strike effect.
       *
       * This is the dial that actually makes the ranks feel different: a D-tier
       * strike is a small pop and a V-tier strike is a full-size event, with each
       * rung in between stepping up. Particle count moves with it, but size is
       * what the eye reads first. The whole range was scaled down: the earlier
       * values were loud enough to compete with the conversation.
       */
      const sizeScale = 0.46 + tier * 0.086;

      // Spark layer: from mid intensity up, denser and larger as the rank climbs.
      // A capped lane throws the densest, biggest ring on every strike.
      const sparkCount = bucket === 'low' ? 0 : (capped ? 22 : (blazing ? 18 : (rich ? 14 : 9)));
      const sparks = hit && sparkCount > 0
        ? particles('dshcombo-sparks', sparkAngles(sparkCount), `s${pulse}`, {
            distance: 78,
            size: 2,
            scale: sizeScale,
          })
        : null;
      // Flash: a soft burst behind the letter, growing with the rank.
      const flash = hit && bucket !== 'low'
        ? h('span', {
            className: 'dshcombo-flash',
            key: `f${pulse}`,
            'data-big': String(blazing),
            style: { '--scale': String(sizeScale) },
          })
        : null;

      // ── break: the counterweight to a hit ──
      // A break fires on any downward rank step, not just when the lane empties:
      // waiting for zero meant the feedback arrived long after the loss was
      // obvious. The letter itself shatters — the real glyph is hidden and a set
      // of clipped copies of it fly apart, so what breaks is the letter rather
      // than an abstract particle standing in for it.
      const downStamp = downAt > 0 && Date.now() - downAt < BREAK_MS ? downAt : 0;
      const broken = downStamp > 0 || (breakAt > 0 && Date.now() - breakAt < BREAK_MS);
      const breakStamp = downStamp > 0 ? downStamp : breakAt;
      const lostRank = downStamp > 0 ? downRank : breakRank;
      const brokenRankTier = lostRank === '' ? 0 : rankIndex(lostRank);
      // Which rank the shattered glyph should render: the one being lost, so the
      // fragments look like the letter the player just saw.
      const shatteredGlyph = lostRank === '' ? rank : lostRank;
      /**
       * Fragment geometry: each piece is a copy of the glyph clipped to one slice
       * of the letter box. The slices are deliberately uneven so the break looks
       * like a fracture rather than a clean cut.
       */
      const SHARDS = [
        { x: '0%', y: '0%', w: '54%', h: '46%', dx: '-16px', dy: '-22px', rot: '-24deg' },
        { x: '46%', y: '0%', w: '54%', h: '52%', dx: '20px', dy: '-18px', rot: '18deg' },
        { x: '0%', y: '44%', w: '46%', h: '56%', dx: '-22px', dy: '20px', rot: '-14deg' },
        { x: '42%', y: '42%', w: '58%', h: '58%', dx: '18px', dy: '26px', rot: '26deg' },
        { x: '18%', y: '14%', w: '34%', h: '34%', dx: '2px', dy: '-30px', rot: '8deg' },
      ];
      const breakFx = broken
        ? h('span', {
            className: 'dshcombo-break',
            key: `bk${breakStamp}`,
            'data-tier': String(brokenRankTier),
          },
            SHARDS.map((shard, index) => h('i', {
              className: 'dshcombo-shard',
              key: index,
              style: {
                left: shard.x,
                top: shard.y,
                width: shard.w,
                height: shard.h,
                '--dx': shard.dx,
                '--dy': shard.dy,
                '--rot': shard.rot,
                '--delay': `${index * 22}ms`,
              },
            }, h('span', { className: 'dshcombo-shard-glyph' }, shatteredGlyph))),
            h('span', { className: 'dshcombo-break-label' }, t('breakLabel')),
          )
        : null;

      // ── rank-up: the loud moment ──
      // Effects are rendered INSIDE the letter's own box (`.dshcombo-anchor`), so
      // they burst from the glyph rather than from the plate's centre — the
      // letter is edge-aligned, and a plate-centred origin would fire from empty
      // space next to it. Keyed by the rank-up stamp so a hit inside the window
      // does not restart the whole burst.
      // The burst key: a rank-up and a capped strike are different events, so the
      // stamp must differ or a hit inside the rank-up window would reuse the old
      // burst instead of firing a fresh one.
      const upKey = surge ? `up${rankup ? rankupPulse : pulse}` : 'none';
      /**
       * A capped lane reuses the burst stack on every strike, so it must be much
       * quieter than a real promotion: 0.42x for a surge versus 1x for a rank-up.
       * Without this the V-tier reward was exhausting rather than satisfying.
       */
      const burstScale = (rankup ? 1 : 0.42) * sizeScale;
      /** Shared style carrying the scale into CSS for the ring/wave/beam layers. */
      const upStyle = { '--up': String(burstScale) };
      // Every layer below widens with the tier: a D→C step is a modest pop, a
      // climb into S or above is a page-scale event. The slider still decides
      // whether the lighter layers appear at all. A capped lane (V) reuses this
      // whole stack on every strike, at a reduced size via the surge attribute.
      const wave = surge
        ? h('span', {
            className: 'dshcombo-wave',
            key: `w${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      const ring = surge
        ? h('span', {
            className: 'dshcombo-ring',
            key: `r${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      const ring2 = surge && (rich || blazing)
        ? h('span', {
            className: 'dshcombo-ring dshcombo-ring-late',
            key: `r2${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      // A third ring appears once the combo is genuinely hot.
      const ring3 = surge && ascendant
        ? h('span', {
            className: 'dshcombo-ring dshcombo-ring-third',
            key: `r3${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      // The long diagonal energy cut: always present, doubled on the heavier
      // ranks and tripled at the top.
      const slashBeam = surge
        ? h('span', {
            className: 'dshcombo-slashbeam',
            key: `sb${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      const slashBeam2 = surge && (rich || blazing)
        ? h('span', {
            className: 'dshcombo-slashbeam dshcombo-slashbeam-cross',
            key: `sb2${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      const slashBeam3 = surge && ascendant
        ? h('span', {
            className: 'dshcombo-slashbeam dshcombo-slashbeam-third',
            key: `sb3${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      const beam = surge
        ? h('span', {
            className: 'dshcombo-beam',
            key: `m${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;
      // The particle burst widens with the tier and gains a second wave at S.
      // Its distance and particle size both ride the same scale as everything
      // else, so the rank ladder is legible at a glance.
      const burst = surge
        ? particles('dshcombo-burst', BURST_ANGLES, `b${upKey}`, {
            distance: 180 + tier * 26,
            duration: 720 + tier * 22,
            size: 3,
            scale: burstScale,
          })
        : null;
      const burst2 = surge && blazing
        ? particles('dshcombo-burst dshcombo-burst-late', BURST_ANGLES, `b2${upKey}`, {
            distance: 120 + tier * 20,
            duration: 900,
            size: 2,
            scale: burstScale,
          })
        : null;
      const streaks = surge && (rich || blazing)
        ? particles('dshcombo-streaks', STREAK_ANGLES, `k${upKey}`, {
            duration: 660,
            scale: burstScale,
          })
        : null;
      const flare = surge && (bucket === 'max' || ascendant)
        ? h('span', {
            className: 'dshcombo-flare',
            key: `l${upKey}`,
            'data-tier': String(tier),
            'data-surge': String(!rankup),
            style: upStyle,
          })
        : null;

      return h(
        'div',
        {
          className: 'dshcombo-rail',
          'data-side': side,
          'data-rank': rank,
          'data-lit': String(lit),
          'data-hit': String(hit),
          'data-rankup': String(rankup),
          'data-i': bucket,
          'data-tier': String(tier),
          'data-capped': String(capped),
          'data-broken': String(broken),
          'data-narrow': String(narrow),
          style,
        },
        h(
          'div',
          { className: 'dshcombo-inner' },
          h('span', { className: 'dshcombo-tag' }, label),
          h(
            'div',
            { className: 'dshcombo-plate' },
            // The skewed slab that anchors the letter to the gutter edge.
            h('span', { className: 'dshcombo-slash', key: 'slash', 'aria-hidden': 'true' }),
            h(
              'span',
              { className: 'dshcombo-anchor' },
              wave,
              flare,
              ring3,
              ring2,
              ring,
              flash,
              h('span', { className: 'dshcombo-rank' }, rank),
              slashBeam3,
              slashBeam2,
              slashBeam,
              beam,
              sparks,
              burst2,
              burst,
              streaks,
              breakFx,
            ),
          ),
          h('span', {
            className: 'dshcombo-count',
            'data-pop': String(hit),
            key: `n${Math.round(hits)}`,
          }, String(Math.round(hits))),
          // Past the cap the lane keeps scoring: this shows how far beyond the
          // final rung it has pushed, which is the only reward left once there is
          // no next rank to climb toward.
          overflow > 0
            ? h('span', {
                className: 'dshcombo-overflow',
                key: `o${overflow}`,
                'data-pop': String(hit),
              }, `+${overflow}`)
            : null,
          // The charge bar sits directly under the letter, slanted into a
          // parallelogram. It fills horizontally from the outer edge inward, so
          // the two rails mirror each other. Tick marks are vertical notches at
          // each rank threshold; the bright leading edge tracks the fill.
          h('span', { className: 'dshcombo-charge', 'aria-hidden': 'true' },
            h('i', { style: { transform: `scaleX(${charge})` } }),
            TICKS.map((tick) => h('b', {
              key: tick,
              'data-passed': String(charge * 100 >= tick),
              style: { left: `${tick}%` },
            })),
            // The edge rides the fill: anchored at the left, so reaching the fill
            // front is a positive translate of the filled width.
            h('s', { style: { transform: `translateX(${charge * CHARGE_WIDTH}px)` } })),
          // Move log: the last few distinct tool names, newest last. Showing a
          // sequence rather than one name is what reveals whether the Agent is
          // varying its tools or grinding the same one.
          moveLog.length > 0
            ? h('span', { className: 'dshcombo-moves' },
                moveLog.map((name, index) => h('i', {
                  key: `${index}-${name}`,
                  className: 'dshcombo-move',
                  'data-latest': String(index === moveLog.length - 1),
                }, name)))
            : (move !== '' ? h('span', { className: 'dshcombo-move' }, move) : null),
          // Floating quips: one line per strike, rising and fading. Keyed by the
          // strike stamp so consecutive hits stack rather than replace.
          quip !== null
            ? h('span', {
                className: 'dshcombo-quip',
                key: `q${quipKey}`,
                'data-kind': quip.kind,
              }, quip.text)
            : null,
          // Stats strip: the numbers the user asked to see, one per lane.
          stats.length > 0
            ? h('span', { className: 'dshcombo-stats' },
                stats.map((stat) => h('span', { className: 'dshcombo-stat', key: stat.label },
                  h('em', null, stat.label),
                  h('b', null, stat.value))))
            : null,
          // Personal best: the historical high-water mark for this lane. Flashes
          // when the current run beats it, which is the only moment the record
          // itself changes.
          best.rank !== ''
            ? h('span', {
                className: 'dshcombo-best',
                'data-fresh': String(bestFresh),
              },
                h('em', null, t('best')),
                h('b', null, best.rank),
                h('i', null, String(best.hits)))
            : null,
        ),
      );
    }

    /**
     * The two rails, painted in the frame-wide overlay and positioned from the
     * geometry the probe published.
     */
    function ComboRails() {
      const s = useSettings();
      const snapshot = useStoreState();
      const rootRef = React.useRef(null);
      /** Last rendered rank per side, for one-shot rank-up effects. */
      const ranksRef = React.useRef({ user: undefined, agent: undefined });
      /** Last quip picked per side, keyed by the strike stamp that produced it. */
      const quipsRef = React.useRef({
        you: { text: '', kind: 'hit', stamp: 0 },
        agent: { text: '', kind: 'hit', stamp: 0 },
      });
      const [, force] = React.useReducer((x) => x + 1, 0);

      // ── personal best ──
      // The ladder gives you something to climb, but without a record there is
      // nothing to compare a run against: reaching SSS with no idea whether it
      // beat last time removes most of the reward. Bests persist per lane across
      // sessions, and a new record fires its own small celebration.
      const bestRef = React.useRef(loadBests());
      const bestHitRef = React.useRef({ user: 0, agent: 0 });

      // Convert the probe's viewport geometry into offsets inside the overlay.
      //
      // IMPORTANT: this measurement must never read the root element's own
      // position, because the result *sets* that position — reading it back
      // creates a feedback loop that collapses the root to left:0 (on top of the
      // sidebar). The origin is therefore the overlay layer (the root's parent),
      // which this component does not move. The probe reports viewport-space
      // geometry, so the parent's viewport origin is subtracted instead.
      const [layout, setLayout] = React.useState({
        frame: 0, frameWidth: 0, left: 0, leftWidth: 0, right: 0, rightWidth: 0,
      });
      React.useEffect(() => {
        let frame = 0;
        const sync = () => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            const root = rootRef.current;
            if (root === null) return;
            // The overlay layer: the element this root is absolutely positioned
            // against. Its rect is stable regardless of where the root sits.
            const parent = root.parentElement;
            const originLeft = parent === null ? 0 : parent.getBoundingClientRect().left;
            const geo = store.geometry;
            if (geo.columnLeft <= 0 || geo.columnRight <= 0 || geo.frameRight <= geo.frameLeft) {
              setLayout({ frame: 0, frameWidth: 0, left: 0, leftWidth: 0, right: 0, rightWidth: 0 });
              return;
            }
            const leftRoom = geo.columnLeft - geo.frameLeft - GUTTER_INSET * 2;
            const rightRoom = geo.frameRight - geo.columnRight - GUTTER_INSET * 2;
            setLayout({
              frame: geo.frameLeft - originLeft,
              frameWidth: geo.frameRight - geo.frameLeft,
              // The rails hug the OUTER frame edges so the composition reads as a
              // frame around the conversation, and the effects that spill inward
              // have room before they reach the text column. Both offsets are
              // measured inside the clipping root, whose left edge is frameLeft.
              left: GUTTER_INSET,
              leftWidth: leftRoom >= MIN_GUTTER ? Math.min(leftRoom, MAX_GUTTER) : 0,
              right: GUTTER_INSET,
              rightWidth: rightRoom >= MIN_GUTTER ? Math.min(rightRoom, MAX_GUTTER) : 0,
            });
          });
        };
        sync();
        const unsubscribe = store.subscribe(sync);
        window.addEventListener('resize', sync);
        return () => {
          unsubscribe();
          window.removeEventListener('resize', sync);
          if (frame !== 0) window.cancelAnimationFrame(frame);
        };
      }, []);

      // Re-render periodically so idle decay and the strike marker expire.
      React.useEffect(() => {
        const id = window.setInterval(() => force(), 240);
        return () => window.clearInterval(id);
      }, []);

      const st = snapshot.state;
      if (!s.enabled || s.intensity <= 0 || !st.live) return null;

      if (layout.leftWidth <= 0 && layout.rightWidth <= 0) {
        return h('div', { ref: rootRef, className: 'dshcombo-root' }, h(Styles, { key: 'css' }));
      }
      // Until the first measurement lands, render nothing visible: a root at its
      // default position would flash over the sidebar for one frame.
      if (layout.frameWidth <= 0) {
        return h('div', { ref: rootRef, className: 'dshcombo-root' }, h(Styles, { key: 'css' }));
      }

      const now = Date.now();
      const bucket = bucketOf(s.intensity);
      const userShown = st.running ? (st.userFrozen || 0) : st.userHits;
      // A settled count stays visible after the turn ends.
      const agentShown = st.running ? st.agentHits : st.agentFrozen;
      const userRank = rankOf(userShown, USER_LADDER);
      const agentRank = rankOf(agentShown, AGENT_LADDER);

      // Rank-up tracking. A step up stamps the time; the burst stays mounted for
      // Rank transition tracking. A step up stamps the time so the burst can
      // play; a step DOWN stamps a break, so losing a rung is visible the moment
      // it happens instead of only when the lane finally empties. Waiting for
      // zero made the feedback arrive long after the loss was already obvious.
      const previousRanks = ranksRef.current;
      if (previousRanks.user !== undefined && rankIndex(userRank) > rankIndex(previousRanks.user)) {
        previousRanks.userAt = now;
      }
      if (previousRanks.agent !== undefined && rankIndex(agentRank) > rankIndex(previousRanks.agent)) {
        previousRanks.agentAt = now;
      }
      // A downward step: record the rank that was left behind, so the break can
      // scale with what was actually lost.
      if (previousRanks.user !== undefined && rankIndex(userRank) < rankIndex(previousRanks.user)) {
        previousRanks.userDownAt = now;
        previousRanks.userDownRank = previousRanks.user;
      }
      if (previousRanks.agent !== undefined && rankIndex(agentRank) < rankIndex(previousRanks.agent)) {
        previousRanks.agentDownAt = now;
        previousRanks.agentDownRank = previousRanks.agent;
      }
      previousRanks.user = userRank;
      previousRanks.agent = agentRank;
      const userRankUp = now - (previousRanks.userAt ?? 0) < RANKUP_MS;
      const agentRankUp = now - (previousRanks.agentAt ?? 0) < RANKUP_MS;

      // A narrow rail cannot carry a 60px letter; step the type down instead of
      // letting it overflow the gutter.
      const narrow = Math.min(layout.leftWidth, layout.rightWidth) < 130;

      const userHit = st.userHitAt > 0 && now - st.userHitAt < HIT_MS;
      const agentHit = st.agentHitAt > 0 && now - st.agentHitAt < HIT_MS;

      // ── quips: one line per strike, and a louder one on a rank step ──
      // The pick is stored with the strike stamp so a re-render during the same
      // strike keeps the same line instead of flickering through the pool.
      const quipRef = quipsRef.current;
      const quipFor = (lane, hitNow, rankUpNow, rankNow, stamp) => {
        if (!s.quips) return null;
        if (!hitNow && !rankUpNow) return null;
        if (quipRef[lane].stamp === stamp && quipRef[lane].text !== '') return quipRef[lane];
        if (stamp === 0) return null;
        const kind = rankUpNow ? 'rankup' : 'hit';
        const pool = rankUpNow
          ? (QUIPS.rankUp[rankNow] ?? QUIPS[lane])
          : QUIPS[lane];
        const text = pool[Math.floor(Math.random() * pool.length)];
        quipRef[lane] = { text, kind, stamp };
        return quipRef[lane];
      };
      const userQuip = quipFor('you', userHit, userRankUp, userRank, st.userHitAt);
      const agentQuip = quipFor('agent', agentHit, agentRankUp, agentRank, st.agentHitAt);

      // ── stats: one line per lane, from the probe's published metrics ──
      const metrics = snapshot.metrics;
      const userStats = [];
      if (s.stats && metrics.cps > 0) userStats.push({ label: 'CPS', value: metrics.cps.toFixed(1) });
      const agentStats = [];
      if (s.stats && metrics.tps > 0) agentStats.push({ label: 'TPS', value: metrics.tps.toFixed(1) });
      if (s.stats && metrics.context > 0) agentStats.push({ label: 'CTX', value: compactCount(metrics.context) });

      // ── personal best: compare this run against the stored record ──
      // A record is only rewritten when the current run genuinely beats it, so
      // the displayed best is always the historical high-water mark rather than
      // the last thing that happened to be on screen.
      const bests = bestRef.current;
      const beats = (lane, rank, hits) => {
        const record = bests[lane];
        if (rank === '') return false;
        const rankBetter = rankIndex(rank) > rankIndex(record.rank);
        const sameRankMore = rank === record.rank && hits > record.hits + 0.5;
        return rankBetter || sameRankMore;
      };
      const userBeats = beats('user', userRank, userShown);
      const agentBeats = beats('agent', agentRank, agentShown);
      if (userBeats) {
        bests.user = { rank: userRank, hits: Math.round(userShown) };
        saveBests(bests);
        bestHitRef.current.user = now;
      }
      if (agentBeats) {
        bests.agent = { rank: agentRank, hits: Math.round(agentShown) };
        saveBests(bests);
        bestHitRef.current.agent = now;
      }
      const userBestFresh = bestHitRef.current.user > 0 && now - bestHitRef.current.user < BEST_MS;
      const agentBestFresh = bestHitRef.current.agent > 0 && now - bestHitRef.current.agent < BEST_MS;

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dshcombo-root',
          style: layout.frameWidth > 0
            ? { left: `${layout.frame}px`, width: `${layout.frameWidth}px` }
            : undefined,
          'aria-live': 'polite',
          'aria-label': `${t('combo')} — ${t('you')} ${Math.round(userShown)} ${userRank} / ${t('agent')} ${Math.round(agentShown)} ${agentRank}`,
        },
        h(Styles, { key: 'css' }),
        layout.leftWidth > 0 ? h(GuardedRail, {
          key: 'you',
          side: 'you',
          label: t('you'),
          hits: userShown,
          rank: userRank,
          charge: chargeOf(userShown, USER_LADDER),
          move: st.userFrozen > 0 ? t('ready') : '',
          moveLog: [],
          lit: !st.running && userShown > 0,
          hit: userHit,
          rankup: userRankUp,
          rankupPulse: previousRanks.userAt ?? 0,
          bucket,
          pulse: st.userHitAt,
          left: layout.left,
          width: layout.leftWidth,
          narrow,
          quip: userQuip,
          quipKey: st.userHitAt,
          stats: userStats,
          ladderTop: USER_LADDER[USER_LADDER.length - 1],
          breakAt: st.userBreakAt,
          breakRank: st.userBreakRank,
          downAt: previousRanks.userDownAt ?? 0,
          downRank: previousRanks.userDownRank ?? '',
          best: bests.user,
          bestFresh: userBestFresh,
        }) : null,
        layout.rightWidth > 0 ? h(GuardedRail, {
          key: 'agent',
          side: 'agent',
          label: t('agent'),
          hits: agentShown,
          rank: agentRank,
          charge: chargeOf(agentShown, AGENT_LADDER),
          move: st.running ? st.lastMove : '',
          moveLog: st.running ? st.moveLog : [],
          lit: st.running && agentShown > 0,
          hit: agentHit,
          rankup: agentRankUp,
          rankupPulse: previousRanks.agentAt ?? 0,
          bucket,
          pulse: st.agentHitAt,
          left: layout.right,
          width: layout.rightWidth,
          narrow,
          quip: agentQuip,
          quipKey: st.agentHitAt,
          stats: agentStats,
          ladderTop: AGENT_LADDER[AGENT_LADDER.length - 1],
          breakAt: st.agentBreakAt,
          breakRank: st.agentBreakRank,
          downAt: previousRanks.agentDownAt ?? 0,
          downRank: previousRanks.agentDownRank ?? '',
          best: bests.agent,
          bestFresh: agentBestFresh,
        }) : null,
      );
    }

    // ── the General-settings row ───────────────────────────────────────────
    /**
     * One preference row: the HUD switch, the intensity slider, and the two
     * content toggles (quips, stats). Effects are peeled away as the slider
     * drops, so every position is meaningful.
     */
    function ComboSettingsRow() {
      const s = useSettings();
      /** Small labelled switch used for the two content toggles. */
      const toggle = (key, label, checked, onChange) => h(
        'span',
        { className: 'dshcombo-toggle' },
        h('span', { className: 'dshcombo-toggle-label' }, label),
        h('button', {
          type: 'button',
          className: 'dshcombo-switch dshcombo-switch-sm',
          role: 'switch',
          'aria-checked': String(checked),
          'aria-label': label,
          disabled: !s.enabled,
          onClick: onChange,
        }),
      );
      return h(
        'div',
        { className: 'dshcombo-row' },
        h(Styles, { key: 'css' }),
        h('div', { className: 'dshcombo-row-text' },
          h('span', { className: 'dshcombo-row-title' }, t('settingsTitle')),
          h('span', { className: 'dshcombo-row-hint' }, t('settingsHint')),
        ),
        h('div', { className: 'dshcombo-row-controls' },
          toggle('quips', t('settingsQuips'), s.quips, () => updateSettings({ quips: !s.quips })),
          toggle('stats', t('settingsStats'), s.stats, () => updateSettings({ stats: !s.stats })),
          h('input', {
            className: 'dshcombo-slider',
            type: 'range',
            min: 0,
            max: 100,
            step: 5,
            value: s.intensity,
            disabled: !s.enabled,
            'aria-label': t('settingsIntensity'),
            onChange: (event) => updateSettings({ intensity: Number(event.target.value) }),
          }),
          h('span', { className: 'dshcombo-row-value' }, `${s.intensity}`),
          h('button', {
            type: 'button',
            className: 'dshcombo-switch',
            role: 'switch',
            'aria-checked': String(s.enabled),
            'aria-label': t('settingsEnable'),
            onClick: () => updateSettings({ enabled: !s.enabled }),
          }),
        ),
      );
    }

    // ── plugin body ────────────────────────────────────────────────────────
    /**
     * Error boundary for the rails. A throwing component blanks its slot entry,
     * which reads to the user as "the plugin vanished"; this keeps a plain
     * fallback on screen and logs the cause instead.
     */
    class RailBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        console.error('[combo] rails crashed, showing fallback', error);
      }

      render() {
        if (this.state.error === null) return this.props.children;
        const message = this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error);
        return h(
          'div',
          { className: 'dshcombo-fallback', role: 'alert' },
          h('b', null, 'combo'),
          h('span', null, ` · ${message}`),
        );
      }
    }

    /** Wrapper registered in the overlay slot so a rail crash cannot blank it. */
    function ComboRailsGuarded() {
      return h(RailBoundary, null, h(ComboRails));
    }

    /**
     * Render one rail inside its own error boundary.
     *
     * The outer boundary covers the whole overlay entry, so a crash on either
     * side previously blanked both. Isolating each side means a bad prop or a
     * DOM surprise on one lane leaves the other lane working, and the failing
     * side simply renders nothing instead of taking the HUD down.
     *
     * @param props - Rail props.
     * @returns the rail, or null when it threw.
     */
    class SideBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('[combo] rail failed, hiding this side only', error);
      }

      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    /** A rail wrapped in its own boundary. */
    function GuardedRail(props) {
      return h(SideBoundary, null, h(Rail, props));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Pull the Host-side tuning before anything renders. The route is
        // optional: a profile without a web server answers nothing and the
        // built-in defaults stand, so this must never block or fail activation.
        loadHostConfig();

        // Locale dictionaries; a missing service keeps the English fallback.
        ctx.effect(() => {
          const locale = ctx.get('locale');
          if (locale === undefined || typeof locale.register !== 'function') return () => {};
          const disposers = [];
          try {
            disposers.push(locale.register('combo', 'zh', DICT.zh));
            disposers.push(locale.register('combo', 'en', DICT.en));
            const bound = typeof locale.bind === 'function' ? locale.bind('combo') : undefined;
            if (typeof bound === 'function') translate = bound;
          } catch (error) {
            console.error('[combo] locale registration failed', error);
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {
                console.error('[combo] locale dispose failed', error);
              }
            }
          };
        }, 'dsh-combo: locale');

        // Probe: owns the state machines, publishes state + geometry.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'combo-probe',
          order: 30,
        }, ComboProbe));

        // Rails: painted in the frame-wide overlay, outside composer containment.
        // Registered through the boundary so a rail crash shows a fallback rather
        // than blanking the slot entry.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'combo-rails',
          order: 40,
        }, ComboRailsGuarded));

        // The preference row inside General settings.
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'combo-settings',
          order: 25,
        }, ComboSettingsRow));
      },
    };
  },
});
