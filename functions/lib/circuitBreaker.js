const state = new Map();

/**
 * Simple in-memory circuit breaker.
 * @param {string} key unique key per external dependency (e.g., "tmdb", "openai")
 * @param {object} opts { failureThreshold, coolDownMs, resetAfterMs, shouldCountFailure }
 * @param {function(): Promise<any>} fn async operation to execute when closed
 *
 * `shouldCountFailure(err)` distingue i guasti del servizio dalle risposte
 * negative ma legittime (es. un 404 atteso): queste ultime vengono rilanciate
 * al chiamante SENZA incrementare il contatore, altrimenti una sequenza di
 * richieste valide ma senza risultato aprirebbe il circuito per tutti gli altri
 * consumatori della stessa chiave. Il contatore non viene nemmeno azzerato: una
 * risposta negativa non e' prova che il servizio sia sano.
 */
async function withCircuitBreaker(key, fn, opts = {}) {
  const now = Date.now();
  const conf = {
    failureThreshold: Math.max(1, opts.failureThreshold ?? 5),
    coolDownMs: Math.max(1000, opts.coolDownMs ?? 5 * 60 * 1000),
    resetAfterMs: Math.max(1000, opts.resetAfterMs ?? 60 * 60 * 1000),
    shouldCountFailure: typeof opts.shouldCountFailure === "function"
      ? opts.shouldCountFailure
      : () => true,
  };

  const slot = state.get(key) || { failures: 0, openedUntil: 0, lastFailureAt: 0 };

  if (slot.openedUntil && now < slot.openedUntil) {
    const remaining = slot.openedUntil - now;
    const err = new Error(`Circuit open for ${key}, retry after ${remaining}ms`);
    err.code = "CIRCUIT_OPEN";
    throw err;
  }

  // Optional soft reset after long quiet period
  if (slot.lastFailureAt && (now - slot.lastFailureAt) > conf.resetAfterMs) {
    slot.failures = 0;
    slot.openedUntil = 0;
  }

  try {
    const result = await fn();
    // success → reset failures
    state.set(key, { failures: 0, openedUntil: 0, lastFailureAt: 0 });
    return result;
  } catch (err) {
    let counts = true;
    try {
      counts = conf.shouldCountFailure(err) !== false;
    } catch (_predicateErr) {
      counts = true;
    }
    if (!counts) throw err;

    const failures = (slot.failures || 0) + 1;
    const openedUntil = failures >= conf.failureThreshold ? (now + conf.coolDownMs) : 0;
    state.set(key, { failures, openedUntil, lastFailureAt: now });
    throw err;
  }
}

module.exports = { withCircuitBreaker };
