/**
 * Host half of @local/dsh-combo.
 *
 * The HUD is entirely browser-side: it reads the composer's draft projection and
 * the Chat tool-result nodes directly, so no Host service, projection, or session
 * event is involved in rendering.
 *
 * What the Host half owns is the *shape of the game*: rank thresholds, decay
 * rate, extra ranks, and the phrase banks. Those were baked into `client.js`,
 * which meant changing one quip required reinstalling the plugin. They now live
 * in this row's `config` and are served over a small read-only route, which the
 * Client half fetches at activation.
 *
 * The route is registered through `webServer` when the profile has one. Profiles
 * without a web server (headless boots) simply skip the route; the Client then
 * keeps its built-in defaults, so the HUD still works.
 *
 * This file deliberately imports nothing. A bundle installed from a workspace
 * directory is linked, not copied, so pnpm does not resolve dependencies declared
 * here — importing `@deepseek-ai/schemastery` would fail at activation. The
 * config schema is therefore hand-written and validated in `resolve`, which also
 * keeps the plugin installable with no dependency tree at all.
 */

/** Route the Client half fetches its tuning from. */
const CONFIG_PATH = '/plugins/dsh-combo/config.json';

/** Default intensity used until the user moves the slider. */
const DEFAULT_INTENSITY = 70;

/**
 * Declared shape of the row config.
 *
 * The Loader calls `Config.validate(value)` on whatever a plugin exports, so a
 * plain JSON-Schema object is not enough — it needs a callable validator. This
 * hand-written one exists because the plugin must stay dependency-free: a bundle
 * installed from a workspace directory is linked rather than copied, so pnpm
 * never resolves dependencies declared here, and importing schemastery would
 * fail at activation.
 *
 * Validation is intentionally permissive: unknown keys are kept (so a newer patch
 * is not rejected by an older plugin) and coercion is deferred to `resolve`,
 * which never throws.
 */
export const Config = {
  type: 'object',
  properties: {
    intensity: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      default: DEFAULT_INTENSITY,
      description: 'Default effect intensity (0-100) until the slider is moved.',
    },
    extraRanks: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      description: 'Extra rank names appended above V. Empty keeps the built-in ladder.',
    },
    you: {
      type: 'object',
      properties: {
        ladder: {
          type: 'array',
          items: { type: 'number', minimum: 1 },
          default: [],
          description: 'Characters needed to reach each rank above D; must be increasing.',
        },
        idleMs: {
          type: 'number',
          minimum: 0,
          maximum: 600000,
          default: 0,
          description: 'Silence before the meter starts draining, in ms.',
        },
        decayPerSec: {
          type: 'number',
          minimum: 0,
          maximum: 1000,
          default: 0,
          description: 'Combo points lost per second once draining.',
        },
      },
    },
    agent: {
      type: 'object',
      properties: {
        ladder: {
          type: 'array',
          items: { type: 'number', minimum: 1 },
          default: [],
          description: 'Settled tool calls needed to reach each rank above D.',
        },
        idleMs: {
          type: 'number',
          minimum: 0,
          maximum: 600000,
          default: 0,
          description: 'Silence before the agent lane resets, in ms.',
        },
      },
    },
    phrases: {
      type: 'object',
      properties: {
        you: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Hit lines for the typing lane; empty keeps the built-in bank.',
        },
        agent: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Hit lines for the tool lane; empty keeps the built-in bank.',
        },
      },
    },
  },

  /**
   * Standard Schema implementation.
   *
   * Cordis validates a plugin's config through `Config['~standard'].validate`,
   * not through a plain `validate` method, so this protocol is what actually
   * makes the row configurable. The contract is synchronous: return `{ value }`
   * on success or `{ issues }` on failure.
   *
   * Validation is deliberately permissive — an unusable value is replaced by the
   * default rather than rejected — because a typo in a hand-edited patch should
   * not take the HUD down. Coercion happens in `resolve`, which also never throws.
   */
  '~standard': {
    version: 1,
    vendor: 'dsh-combo',
    /**
     * Validate a row config.
     * @param value - raw config from the patch.
     * @returns `{ value }` with an object config, or `{ issues }` when unusable.
     */
    validate(value) {
      if (value === null || value === undefined) return { value: {} };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return {
          issues: [{ message: 'combo config must be an object', path: [] }],
        };
      }
      return { value };
    },
  },
};

/**
 * Normalise a threshold list: coerce to integers, drop non-positive entries and
 * force ascending order. A hand-edited YAML list is easy to get slightly wrong,
 * and a non-monotonic ladder would make `rankOf` skip rungs.
 *
 * @param values - raw thresholds from config.
 * @returns strictly ascending thresholds; empty when nothing usable remains.
 */
function normaliseLadder(values) {
  if (!Array.isArray(values)) return [];
  const cleaned = [];
  for (const value of values) {
    const next = Math.round(Number(value));
    if (!Number.isFinite(next) || next <= 0) continue;
    if (cleaned.length > 0 && next <= cleaned[cleaned.length - 1]) continue;
    cleaned.push(next);
  }
  return cleaned;
}

/**
 * Filter a phrase list to non-empty trimmed strings.
 * @param values - raw list from config.
 * @returns usable lines.
 */
function cleanPhrases(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((line) => typeof line === 'string' && line.trim() !== '')
    .map((line) => line.trim());
}

/**
 * Read a positive number within a ceiling, or null when unusable.
 * @param value - raw value.
 * @param max - upper bound.
 * @returns the number, or null.
 */
function positiveNumber(value, max) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0 || next > max) return null;
  return next;
}

/**
 * Build the resolved document the Client half consumes.
 *
 * Every field is optional: the Client merges what it receives over its own
 * defaults, so a partial config is valid and an empty one changes nothing. All
 * input is treated as untrusted — it may be hand-edited YAML — and anything that
 * fails validation is dropped rather than rejecting the whole document, so one
 * typo cannot disable the plugin.
 *
 * @param config - the row config as loaded from the patch.
 * @returns a plain JSON document.
 */
export function resolve(config) {
  const source = config ?? {};
  const intensity = Number(source.intensity);
  const resolved = {
    intensity: Number.isFinite(intensity)
      ? Math.min(100, Math.max(0, Math.round(intensity)))
      : DEFAULT_INTENSITY,
  };

  const extraRanks = cleanPhrases(source.extraRanks).slice(0, 4);
  if (extraRanks.length > 0) resolved.extraRanks = extraRanks;

  const you = source.you ?? {};
  const agent = source.agent ?? {};
  const youLadder = normaliseLadder(you.ladder);
  const agentLadder = normaliseLadder(agent.ladder);
  if (youLadder.length > 0) resolved.youLadder = youLadder;
  if (agentLadder.length > 0) resolved.agentLadder = agentLadder;

  const youIdle = positiveNumber(you.idleMs, 600000);
  const agentIdle = positiveNumber(agent.idleMs, 600000);
  if (youIdle !== null) resolved.youIdleMs = Math.round(youIdle);
  if (agentIdle !== null) resolved.agentIdleMs = Math.round(agentIdle);

  const youDecay = positiveNumber(you.decayPerSec, 1000);
  if (youDecay !== null) resolved.youDecayPerSec = youDecay;

  const phrases = source.phrases ?? {};
  const youPhrases = cleanPhrases(phrases.you);
  const agentPhrases = cleanPhrases(phrases.agent);
  if (youPhrases.length > 0) resolved.youPhrases = youPhrases;
  if (agentPhrases.length > 0) resolved.agentPhrases = agentPhrases;
  return resolved;
}

/**
 * Register the Host half.
 *
 * The resolved document is served read-only over an exact route. `inject` is
 * empty so activation is not deferred until a web server exists, which means the
 * server may arrive after this runs; registration therefore retries on a short
 * timer until it succeeds, and the timer is cleared on teardown.
 *
 * @param ctx - plugin context.
 * @param config - the row config.
 */
export function apply(ctx, config) {
  const document = resolve(config);
  const body = JSON.stringify(document);

  /** Serve the resolved document. */
  const handler = (_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  };

  /** @returns the route disposer, or null when no web server is available yet. */
  const registerRoute = () => {
    let server = null;
    try {
      server = typeof ctx.get === 'function' ? ctx.get('webServer') : null;
    } catch (error) {
      // A missing service is expected in headless profiles.
    }
    if (server === null || server === undefined || typeof server.register !== 'function') return null;
    try {
      return server.register({ kind: 'exact', path: CONFIG_PATH, handler });
    } catch (error) {
      // A duplicate exact route means a previous activation already owns it.
      console.error('[combo] could not register the config route', error);
      return null;
    }
  };

  ctx.effect(() => {
    let disposeRoute = registerRoute();
    let timer = null;
    if (disposeRoute === null) {
      // The web server is not up yet; poll until it appears. `unref` keeps this
      // from holding the process open in a profile that never has one.
      timer = setInterval(() => {
        disposeRoute = registerRoute();
        if (disposeRoute !== null && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }, 500);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (disposeRoute !== null) {
        try {
          disposeRoute();
        } catch (error) {
          console.error('[combo] could not dispose the config route', error);
        }
      }
    };
  }, 'dsh-combo: config route');
}

export default { apply, Config };
