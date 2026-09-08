import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegions, selectedRegionIds, fetchRegionAvailability } from '../web/regions.js';

const catalog = [{ id: '1', name: '서울/인천/경기' }, { id: '2', name: '강원' }, { id: '9', name: '제주' }];
const result = (region, patch = {}) => ({
  query: { region, month: '202609', type: 'all', guests: 2, nights: 1 },
  forests: [{ id: 'forest-' + region, regionId: region }],
  coverage: { discovered: 1, complete: 1, pending: 0, missingRegions: 0, regionTotal: 1 },
  job: { id: 'current', updatedAt: '2026-09-08T01:00:00Z' },
  queryVersion: '2026-09-08T01:00:00Z', fetchedAt: '2026-09-08T01:01:00Z', ...patch
});

test('region selections normalize duplicates, empty choices and all', () => {
  assert.equal(normalizeRegions(' 2,1,2 '), '2,1');
  assert.equal(normalizeRegions(['2', '1', '2']), '2,1');
  for (const value of ['', null, undefined, [], 'all', ['1', 'all']]) {
    assert.equal(normalizeRegions(value), 'all');
    assert.deepEqual(selectedRegionIds(value), []);
  }
  assert.deepEqual(selectedRegionIds('2,1,2'), ['2', '1']);
});

test('catalog validates choices and orders them; choosing every region means all', () => {
  assert.equal(normalizeRegions('9,2,missing', catalog), '2,9');
  assert.equal(normalizeRegions('missing', catalog), 'all');
  assert.equal(normalizeRegions(['9', '2', '1'], catalog), 'all');
  assert.equal(normalizeRegions('2,1', []), '2,1');
});

test('single-region and nationwide filters retain the existing one-read behavior', async () => {
  for (const region of ['all', '1', '1,1']) {
    const calls = [], expected = result(region === 'all' ? 'all' : '1');
    const actual = await fetchRegionAvailability(async (...args) => { calls.push(args); return expected; }, 'month=202609&region=' + region);
    assert.equal(actual, expected);
    assert.deepEqual(calls, [['/api/availability?month=202609&region=' + (region === 'all' ? 'all' : '1')]]);
  }
});

test('multiple regions are read once each with all result conditions and aggregated coverage', async () => {
  const calls = [], responses = {
    '1': result('1', { forests: [{ id: 'a' }, { id: 'b' }], coverage: { discovered: 2, complete: 1, pending: 1, missingRegions: 0, regionTotal: 1 } }),
    '2': result('2', { forests: [], coverage: { discovered: 0, complete: 0, pending: 0, missingRegions: 1, regionTotal: 1 } })
  };
  const conditions = 'month=202610&region=1,2,1&type=camp&guests=4&nights=3&weekend=true&includeWait=false';
  const actual = await fetchRegionAvailability(async (...args) => {
    calls.push(args);
    return responses[new URL('http://local' + args[0]).searchParams.get('region')];
  }, conditions);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => args.length === 1));
  for (const [index, [path]] of calls.entries()) {
    const params = new URL('http://local' + path).searchParams;
    assert.equal(params.get('region'), String(index + 1));
    const expected = new URLSearchParams(conditions); expected.set('region', String(index + 1));
    assert.deepEqual([...params], [...expected]);
  }
  assert.deepEqual(actual.forests.map(forest => forest.id), ['a', 'b']);
  assert.equal(actual.query.region, '1,2');
  assert.deepEqual(actual.coverage, { discovered: 2, complete: 1, pending: 1, missingRegions: 1, regionTotal: 2 });
});

test('union removes duplicate forests and keeps latest response metadata together', async () => {
  const older = result('1', { forests: [{ id: 'shared' }, { id: 'a' }], fetchedAt: '2026-09-08T01:03:00Z' });
  const newer = result('2', { forests: [{ id: 'shared' }, { id: 'b' }], job: { id: 'next', updatedAt: '2026-09-08T01:02:00Z' }, queryVersion: '2026-09-08T01:02:00Z', fetchedAt: '2026-09-08T01:02:01Z' });
  const actual = await fetchRegionAvailability(path => Promise.resolve(path.endsWith('region=1') ? older : newer), 'region=1,2');
  assert.deepEqual(actual.forests.map(forest => forest.id), ['shared', 'a', 'b']);
  assert.equal(actual.job, newer.job);
  assert.equal(actual.queryVersion, newer.queryVersion);
  assert.equal(actual.fetchedAt, newer.fetchedAt);
});

test('one region failure rejects the whole read instead of publishing incomplete results', async () => {
  const failure = Object.assign(new Error('연결을 확인해주세요.'), { code: 'NETWORK_OFFLINE' });
  await assert.rejects(fetchRegionAvailability(async path => {
    if (path.endsWith('region=2')) throw failure;
    return result('1');
  }, 'region=1,2'), error => error === failure);
  await assert.rejects(fetchRegionAvailability(async path => path.endsWith('region=2') ? {} : result('1'), 'region=1,2'), { code: 'INVALID_RESPONSE' });
});
