import test from 'node:test';
import assert from 'node:assert/strict';
import { FacilitySource } from '../server/facility-source.mjs';

const query = { forestId: 'ID02030062', unitId: 'GID020300620200202002001000046', type: 'camp' };
const imageUrl = 'https://image.foresttrip.go.kr/ino/goods/deck.png';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
const fixture = `<script>throw new Error('must never execute')</script>
<div class="layer_head"><h2 class="head_title">제1야영장 (데크 20)</h2></div>
<div id="tab_con">
  <div class="con_item">
    <div id="photo_wrap_1">
      <div class="photo_control"><img src="/images/board/sl_left.png"></div>
      <div class="photo_view"><img src="${imageUrl}" alt="외부이미지"></div>
      <div class="photo_list"><ul><li><a href="${imageUrl}"><img src="${imageUrl}" alt="외부이미지" onerror="alert('no')"></a></li>
      <li><img src="${imageUrl}" alt="중복"></li></ul></div>
    </div>
    <h3>기본정보</h3>
    <table class="tbl"><tbody>
      <tr><th>숙박시설 명</th><td>야영데크</td></tr>
      <tr><th>방이름</th><td>제1야영장 (데크 20)</td></tr>
      <tr><th>인실/면적</th><td>기준인원 : 1<br>최대인원 : 4<br>면적 : 24㎡</td></tr>
      <tr><th>편의시설</th><td>공동취사장,\n  샤워실<script>steal()</script></td></tr>
      <tr><th>입/퇴실 시간</th><td>15:00 ~ 11:00</td></tr>
    </tbody></table>
    <h3>가격정보</h3><table><tr><th>비수기</th><td>20,000원</td></tr></table>
  </div>
  <div class="con_item" style="display:none;">
    <h3>이용안내</h3>
    <p class="wd_txt" style="white-space:break-spaces;"><p>◈ 야영장 이용 준수사항◈</p><p>1. 이용시간은 15:00부터<br>다음날 11:00까지 입니다.</p><p>2. 전기시설 이용은 불가능합니다.</p></p>
    <script>fetch('/secret')</script><style>.x{display:none}</style>
  </div>
  <div class="con_item" style="display:none;">
    <div id="photo_wrap_2"><div class="photo_list">
      <a href="https://image.foresttrip.go.kr/ino/instt/site.jpg"><img src="https://image.foresttrip.go.kr/ino/instt/site.jpg" alt="전체배치도"></a>
      <a href="https://image.foresttrip.go.kr/ino/goods/detail.png"><img src="https://image.foresttrip.go.kr/ino/goods/detail.png" alt="상세배치도"></a>
      <img src="https://other.example/ino/goods/foreign.png" alt="외부 호스트">
      <img src="https://image.foresttrip.go.kr/ino/goods/no_img.png" alt="플레이스홀더">
    </div></div>
  </div>
  <div class="con_item" style="display:none;">
    <div id="photo_wrap_3"><div class="photo_list"><img src="https://image.foresttrip.go.kr" alt="평면도"><img src="/images/common/no_img.gif"></div></div>
  </div>
</div>`;

test('public detail reads the first facts table, malformed guide paragraphs and original image lists without cookies', async () => {
  let called = 0;
  const source = new FacilitySource(async (url, options) => {
    called++;
    assert.equal(url, 'https://www.foresttrip.go.kr/pot/rm/fa/selectFcltsArmpDtlView.do?insttId=ID02030062&goodsId=GID020300620200202002001000046');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.keys(options.headers).some(name => /cookie|authorization|csrf/i.test(name)), false);
    return new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'must-not-be-retained=1' } });
  });
  const result = await source.detail(query);
  assert.equal(called, 1);
  assert.equal(result.title, '제1야영장 (데크 20)');
  assert.equal(result.forestId, query.forestId);
  assert.equal(result.unitId, query.unitId);
  assert.equal(result.type, 'camp');
  assert.deepEqual(result.facts, [
    { label: '숙박시설 명', value: '야영데크' },
    { label: '방이름', value: '제1야영장 (데크 20)' },
    { label: '인실/면적', value: '기준인원 : 1\n최대인원 : 4\n면적 : 24㎡' },
    { label: '편의시설', value: '공동취사장, 샤워실' },
    { label: '입/퇴실 시간', value: '15:00 ~ 11:00' }
  ]);
  assert.deepEqual(result.guide, ['◈ 야영장 이용 준수사항◈', '1. 이용시간은 15:00부터', '다음날 11:00까지 입니다.', '2. 전기시설 이용은 불가능합니다.']);
  assert.deepEqual(result.images, [
    { kind: 'photo', label: '외부이미지', sourceUrl: imageUrl },
    { kind: 'map', label: '전체배치도', sourceUrl: 'https://image.foresttrip.go.kr/ino/instt/site.jpg' },
    { kind: 'map', label: '상세배치도', sourceUrl: 'https://image.foresttrip.go.kr/ino/goods/detail.png' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /<script|steal\(|fetch\(|20,000원|onerror/);
});

test('plain wd_txt newlines survive and real floorplans in inactive tabs remain available', async () => {
  const html = fixture.replace(/<p class="wd_txt"[\s\S]*?<\/p><\/p>/, '<p class="wd_txt" style="white-space:break-spaces;">첫 안내\n둘째 안내<br>셋째 안내</p>')
    .replace('src="https://image.foresttrip.go.kr" alt="평면도"', 'src="https://image.foresttrip.go.kr/ino/goods/floor.png" alt="평면도"');
  const result = await new FacilitySource(async () => new Response(html, { headers: { 'Content-Type': 'text/html' } })).detail({ ...query, type: 'stay' });
  assert.deepEqual(result.guide, ['첫 안내', '둘째 안내', '셋째 안내']);
  assert.deepEqual(result.images.at(-1), { kind: 'floorplan', label: '평면도', sourceUrl: 'https://image.foresttrip.go.kr/ino/goods/floor.png' });
});

test('invalid inputs and login or changed HTML do not become successful cached details', async () => {
  let calls = 0;
  const source = new FacilitySource(async () => { calls++; return new Response('<form id="fripPotForm"><input name="loginPwd"></form>', { headers: { 'Content-Type': 'text/html' } }); });
  for (const input of [{ ...query, forestId: '../a' }, { ...query, unitId: '' }, { ...query, type: 'all' }]) {
    await assert.rejects(source.detail(input), e => e.code === 'INVALID_INPUT' && e.status === 400);
  }
  assert.equal(calls, 0);
  await assert.rejects(source.detail(query), e => e.code === 'SOURCE_CHANGED');
});

test('detail redirects can use the canonical host without replaying set-cookie headers', async () => {
  const calls = [];
  const source = new FacilitySource(async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: url.replace('www.foresttrip', 'foresttrip'), 'Set-Cookie': 'secret=1' } }) : new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  });
  const result = await source.detail(query);
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(calls[1].options.headers).some(name => /cookie/i.test(name)), false);
  assert.ok(result.sourceUrl.startsWith('https://foresttrip.go.kr/'));
});

test('forbidden image URLs are rejected before a request', async () => {
  let calls = 0;
  const source = new FacilitySource(async () => { calls++; return new Response(png); });
  for (const url of ['http://image.foresttrip.go.kr/ino/goods/a.png', 'https://image.foresttrip.go.kr.evil.test/ino/goods/a.png', 'https://user:pass@image.foresttrip.go.kr/ino/goods/a.png', 'https://image.foresttrip.go.kr:444/ino/goods/a.png', 'https://image.foresttrip.go.kr/', 'https://image.foresttrip.go.kr/images/common/no_img.gif', 'https://www.foresttrip.go.kr/ino/goods/a.png', 'https://image.foresttrip.go.kr/ino/../private.png']) {
    await assert.rejects(source.image(url), e => e.code === 'SOURCE_CHANGED');
  }
  assert.equal(calls, 0);
});

test('redirect destinations are checked for both HTML and images', async () => {
  for (const mode of ['detail', 'image']) {
    let calls = 0;
    const source = new FacilitySource(async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://other.example/private' } }); });
    await assert.rejects(mode === 'detail' ? source.detail(query) : source.image(imageUrl), e => e.code === 'SOURCE_CHANGED');
    assert.equal(calls, 1);
  }
});

test('image requests send conditional validators and accept a matching 304', async () => {
  const source = new FacilitySource(async (url, options) => {
    assert.equal(url, imageUrl);
    assert.equal(options.headers['If-None-Match'], '"version-1"');
    assert.equal(options.headers['If-Modified-Since'], 'Wed, 09 Sep 2026 12:00:00 GMT');
    assert.equal(options.credentials, 'omit');
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await source.image(imageUrl, { etag: '"version-1"', lastModified: 'Wed, 09 Sep 2026 12:00:00 GMT' }), { notModified: true });
});

test('image bytes determine the MIME type and preserve response validators', async () => {
  const source = new FacilitySource(async () => new Response(png, { headers: { 'Content-Type': 'image/png', ETag: '"image-v1"', 'Last-Modified': 'Wed, 09 Sep 2026 12:00:00 GMT' } }));
  assert.deepEqual(await source.image(imageUrl), { bytes: png, contentType: 'image/png', etag: '"image-v1"', lastModified: 'Wed, 09 Sep 2026 12:00:00 GMT' });
  for (const [bytes, contentType] of [
    [Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    [new TextEncoder().encode('GIF89a'), 'image/gif'],
    [Uint8Array.from(Buffer.from('52494646100000005745425056503820', 'hex')), 'image/webp']
  ]) {
    const result = await new FacilitySource(async () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).image(imageUrl);
    assert.equal(result.contentType, contentType);
  }
});

test('HTML, SVG, false MIME types and incomplete magic are not cached as images', async () => {
  for (const [body, declared] of [['<html>denied</html>', 'image/png'], ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml'], [png, 'text/html'], [png, 'image/jpeg'], [Uint8Array.of(137, 80, 78), 'image/png']]) {
    const source = new FacilitySource(async () => new Response(body, { headers: { 'Content-Type': declared } }));
    await assert.rejects(source.image(imageUrl), e => e.code === 'SOURCE_CHANGED');
  }
});

test('the HTML size limit cancels oversized bodies before reading or while streaming', async () => {
  for (const advertised of [true, false]) {
    let canceled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600 * 1024)); },
      cancel() { canceled = true; }
    });
    const source = new FacilitySource(async () => new Response(stream, { headers: advertised ? { 'Content-Length': String(1024 * 1024 + 1) } : {} }));
    await assert.rejects(source.detail(query), e => e.code === 'SOURCE_CHANGED');
    assert.equal(canceled, true);
  }
});

test('the image limit rejects advertised and streamed bodies over 8 MB', async () => {
  for (const advertised of [true, false]) {
    let canceled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { canceled = true; }
    });
    const source = new FacilitySource(async () => new Response(stream, { headers: advertised ? { 'Content-Length': String(8 * 1024 * 1024 + 1) } : {} }));
    await assert.rejects(source.image(imageUrl), e => e.code === 'SOURCE_CHANGED');
    assert.equal(canceled, true);
  }
});

test('source refusals, missing files and transport failures return safe errors', async () => {
  for (const [status, code] of [[403, 'ACCESS_LIMIT'], [429, 'ACCESS_LIMIT'], [404, 'FACILITY_NOT_FOUND'], [401, 'AUTH_REQUIRED'], [500, 'NETWORK']]) {
    const source = new FacilitySource(async () => new Response('private upstream text', { status }));
    await assert.rejects(source.detail(query), e => e.code === code && !e.message.includes('private upstream text'));
  }
  for (const error of [new Error('secret transport credentials'), new DOMException('raw timeout', 'TimeoutError')]) {
    const source = new FacilitySource(async () => { throw error; });
    await assert.rejects(source.image(imageUrl), e => e.code === 'NETWORK' && !/credentials|raw timeout/.test(e.message));
  }
});
