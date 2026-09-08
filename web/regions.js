export function normalizeRegions(value, catalogRegions) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item ?? '').split(','))
    .map(id => id.trim()).filter(Boolean);
  if (!values.length || values.includes('all')) return 'all';
  const selected = new Set(values);
  if (Array.isArray(catalogRegions) && catalogRegions.length) {
    const catalog = [...new Set(catalogRegions.map(region => String(region.id ?? region)))];
    const ids = catalog.filter(id => selected.has(id));
    return !ids.length || ids.length === catalog.length ? 'all' : ids.join(',');
  }
  return [...selected].join(',');
}

export function selectedRegionIds(value) {
  const normalized = normalizeRegions(value);
  return normalized === 'all' ? [] : normalized.split(',');
}

const responseTime = response => {
  const version = Date.parse(response.queryVersion || response.job?.updatedAt || '');
  return Number.isFinite(version) ? version : Date.parse(response.fetchedAt || '') || 0;
};

export async function fetchRegionAvailability(api, queryString) {
  const params = new URLSearchParams(queryString);
  const region = normalizeRegions(params.get('region'));
  const ids = selectedRegionIds(region);
  if (ids.length < 2) {
    if (params.has('region')) params.set('region', region);
    return api('/api/availability?' + params.toString());
  }

  // These requests only read stored availability; collection still uses its own scope.
  const responses = await Promise.all(ids.map(id => {
    const selected = new URLSearchParams(params);
    selected.set('region', id);
    return api('/api/availability?' + selected.toString());
  }));
  if (responses.some(response => !Array.isArray(response?.forests))) {
    throw Object.assign(new Error('지역별 결과를 모두 불러오지 못했어요. 다시 시도해주세요.'), { code: 'INVALID_RESPONSE' });
  }

  const latest = responses.reduce((current, response) => {
    const difference = responseTime(response) - responseTime(current);
    if (difference > 0 || (difference === 0 && Date.parse(response.fetchedAt || '') > Date.parse(current.fetchedAt || ''))) return response;
    return current;
  });
  const forests = new Map();
  const coverage = { discovered: 0, complete: 0, pending: 0, missingRegions: 0, regionTotal: 0 };
  for (const response of responses) {
    for (const forest of response.forests) if (!forests.has(forest.id)) forests.set(forest.id, forest);
    for (const key of Object.keys(coverage)) coverage[key] += Number(response.coverage?.[key]) || 0;
  }
  return { ...latest, query: { ...latest.query, region }, forests: [...forests.values()], coverage };
}
