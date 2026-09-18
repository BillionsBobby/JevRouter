// Only loaded explicitly by integration tests, never by production code.
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  if (!options.headers.Authorization?.includes('fixture-key')) return new Response('{}', { status: 401 });
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    const choice = keys.includes('ready') ? 'ready' : keys.includes('search_web') ? 'search_web' : keys[0];
    return [id, { type: 'choice', choice, confidence: 0.97, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
  }));
  return Response.json({ model: 'fixture-jev', answers, usage: { input_tokens: 100 } });
};
