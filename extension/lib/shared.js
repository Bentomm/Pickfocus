/* Shared policy. No user history or model credentials live here. */
(() => {
  const defaults = { enabled: false, purpose: '', keywords: '', engine: 'local' };
  const labels = { local: '단어 일치 체험', gemini: 'Gemini Decision 1' };
  function settings(value = {}) {
    return {
      enabled: value.enabled === true,
      purpose: String(value.purpose || '').trim().slice(0, 500),
      keywords: String(value.keywords || '').trim().slice(0, 500),
      engine: Object.hasOwn(labels, value.engine) ? value.engine : 'local'
    };
  }
  function normalize(value) { return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(); }
  function terms(value) { return [...new Set(value.split(/[,\n]/).map(normalize).filter(Boolean))]; }
  function localDecision(config, text) {
    if (!config.purpose.trim() || !terms(config.keywords).length || !text.trim()) return { decision: 'uncertain' };
    // Deliberately literal, never described as semantic or AI classification.
    const matched = terms(config.keywords).some(term => normalize(text).includes(term));
    return { decision: matched ? 'related' : 'unrelated' };
  }
  function validRequest(body) {
    if (!body || body.engine !== 'gemini' || typeof body.purpose !== 'string' ||
        !body.purpose.trim() || body.purpose.length > 500 || !Array.isArray(body.items) ||
        body.items.length < 1 || body.items.length > 50 || body.items.some(text =>
          typeof text !== 'string' || !text.trim() || text.length > 500)) throw new Error('입력 형식을 확인해 주세요.');
    return body;
  }
  globalThis.PickFocus = { defaults, labels, settings, terms, localDecision, validRequest };
})();
