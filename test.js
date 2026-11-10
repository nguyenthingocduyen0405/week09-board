/**
 * 9주차 게시판 API 자동 회귀 테스트 (의존성 없음, Node 18+ 전역 fetch 사용)
 * 실행: 서버(node server.js)를 켠 상태에서  node test.js
 */
const BASE = "http://localhost:3000";

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    results.push({ name, status: "PASS", detail: detail || "" });
  } else {
    failed++;
    results.push({ name, status: "FAIL", detail: detail || "" });
  }
}

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ===== 1. 검색 & 정렬 =====
  {
    const { body } = await get("/api/posts?search=파스타&limit=100");
    const all = body.items.every(
      (p) => p.title.includes("파스타") || p.content.includes("파스타"),
    );
    check("검색: 제목·내용 부분 일치만 반환", all && body.meta.totalCount > 0,
      "totalCount=" + body.meta.totalCount);
  }
  {
    // 내용에만 있는 키워드(장소명은 제목·내용 둘 다 포함되므로 '먹었습니다'로 내용 검색 확인)
    const { body } = await get("/api/posts?search=먹었습니다&limit=1");
    check("검색: 내용(content) 필드도 검색 대상", body.meta.totalCount === 1000,
      "totalCount=" + body.meta.totalCount);
  }
  {
    const { body } = await get("/api/posts?search=존재하지않는키워드zzz");
    check("검색: 결과 0건 처리", body.items.length === 0 && body.meta.totalCount === 0
      && body.meta.totalPages === 1 && body.meta.page === 1,
      JSON.stringify(body.meta));
  }
  {
    const { body } = await get("/api/posts?sort=latest&limit=5");
    const ids = body.items.map((p) => p.id);
    check("정렬: latest = id 내림차순", JSON.stringify(ids) === JSON.stringify([1000, 999, 998, 997, 996]),
      "ids=" + ids);
  }
  {
    const { body } = await get("/api/posts?sort=oldest&limit=5");
    const ids = body.items.map((p) => p.id);
    check("정렬: oldest = id 오름차순", JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 5]),
      "ids=" + ids);
  }
  {
    const { body } = await get("/api/posts?sort=views&limit=100");
    let ok = true;
    let tiePairs = 0; // 실제로 동점이 발생했는지 세어, 테스트가 공허하게 통과하는 것을 막는다
    for (let i = 1; i < body.items.length; i++) {
      const a = body.items[i - 1], b = body.items[i];
      if (a.views < b.views) ok = false;
      if (a.views === b.views) {
        tiePairs++;
        if (a.id < b.id) ok = false; // 동점 시 id DESC
      }
    }
    check("정렬: views 내림차순 + 동점 시 id DESC 2차 정렬 (동점 표본 존재)",
      ok && tiePairs > 0, "동점 쌍=" + tiePairs);
  }
  for (const bad of ["constructor", "prototype", "toString", "__proto__", "hasOwnProperty", "views1", ""]) {
    const { body } = await get("/api/posts?sort=" + encodeURIComponent(bad) + "&limit=3");
    const ids = body.items.map((p) => p.id);
    check("정렬 화이트리스트: sort=" + (bad || "(빈값)") + " → latest 폴백",
      body.meta.sort === "latest" && JSON.stringify(ids) === JSON.stringify([1000, 999, 998]),
      "meta.sort=" + body.meta.sort);
  }

  // ===== 2-A. 오프셋 페이지네이션 =====
  {
    const { body } = await get("/api/posts?page=2&limit=10");
    const ids = body.items.map((p) => p.id);
    check("오프셋: page=2, limit=10 → id 990~981",
      ids[0] === 990 && ids[9] === 981 && body.items.length === 10, "ids=" + ids);
  }
  {
    const { body } = await get("/api/posts?page=100&limit=10");
    check("오프셋: 마지막 페이지(100) 경계 = id 10~1",
      body.items.length === 10 && body.items[0].id === 10 && body.items[9].id === 1
      && body.meta.hasNext === false && body.meta.hasPrev === true);
  }
  {
    const { body } = await get("/api/posts?page=1&limit=10");
    const m = body.meta;
    check("오프셋: meta 필드 정합성 (totalCount/totalPages/hasNext/hasPrev)",
      m.totalCount === 1000 && m.totalPages === 100 && m.page === 1
      && m.hasNext === true && m.hasPrev === false && m.limit === 10,
      JSON.stringify(m));
  }
  for (const [q, desc] of [
    ["page=0", "page=0"], ["page=-5", "page=-5"], ["page=abc", "page=abc"], ["page=1.7", "page=1.7"],
  ]) {
    const { body } = await get("/api/posts?" + q);
    check("오프셋 방어: " + desc + " → page 1 폴백", body.meta.page === 1 && body.items[0].id === 1000);
  }
  {
    const { body } = await get("/api/posts?limit=0");
    check("오프셋 방어: limit=0 → 기본 10", body.meta.limit === 10);
  }
  {
    const { body } = await get("/api/posts?limit=99999");
    check("오프셋 방어: limit=99999 → 상한 100", body.meta.limit === 100 && body.items.length === 100);
  }
  {
    const { body } = await get("/api/posts?page=99999");
    check("오프셋 방어: 범위 밖 page → 마지막 페이지로 보정",
      body.meta.page === 100 && body.items[0].id === 10);
  }
  {
    // 연속 페이지 중복·누락 검증 (views 정렬: 동점이 많아 2차 정렬 없으면 깨지는 케이스)
    const seen = new Set();
    let dup = false;
    for (let p = 1; p <= 100; p++) {
      const { body } = await get("/api/posts?sort=views&page=" + p + "&limit=10");
      for (const it of body.items) {
        if (seen.has(it.id)) dup = true;
        seen.add(it.id);
      }
    }
    check("오프셋: views 정렬 전 100페이지 순회 → 중복 없음·누락 없음(1000건 전부)",
      !dup && seen.size === 1000, "unique=" + seen.size + ", dup=" + dup);
  }

  // ===== 2-B. 커서 페이지네이션 =====
  {
    const { body } = await get("/api/posts/cursor?limit=10");
    const ids = body.items.map((p) => p.id);
    check("커서: 첫 요청 → id 1000~991, hasNext=true, nextCursor=991",
      ids[0] === 1000 && ids[9] === 991 && body.meta.hasNext === true
      && body.meta.nextCursor === 991, JSON.stringify(body.meta));
  }
  {
    const { body } = await get("/api/posts/cursor?cursor=991&limit=10");
    const ids = body.items.map((p) => p.id);
    check("커서: cursor=991 → id 990~981 (중복·누락 없음)",
      ids[0] === 990 && ids[9] === 981);
  }
  {
    const { body } = await get("/api/posts/cursor?cursor=11&limit=10");
    check("커서: 마지막 배치 → 10건, hasNext=false",
      body.items.length === 10 && body.items[9].id === 1 && body.meta.hasNext === false,
      JSON.stringify(body.meta));
  }
  {
    const { body } = await get("/api/posts/cursor?search=초밥&limit=10");
    const okSearch = body.items.every((p) => p.title.includes("초밥") || p.content.includes("초밥"));
    let descOk = true;
    for (let i = 1; i < body.items.length; i++) {
      if (body.items[i - 1].id <= body.items[i].id) descOk = false;
    }
    check("커서: 검색(search=초밥) 지원 + id DESC 유지", okSearch && descOk && body.items.length === 10);
  }
  {
    // 검색 + 커서 전체 순회: 오프셋 전체 결과와 집합이 일치해야 함 (누락·중복 없음)
    const offsetAll = [];
    for (let p = 1; p <= 10; p++) {
      const { body } = await get("/api/posts?search=초밥&page=" + p + "&limit=100");
      offsetAll.push(...body.items.map((x) => x.id));
      if (!body.meta.hasNext) break;
    }
    const cursorAll = [];
    let cur = null, guard = 0, dup = false;
    while (guard++ < 200) {
      const q = "/api/posts/cursor?search=초밥&limit=10" + (cur ? "&cursor=" + cur : "");
      const { body } = await get(q);
      for (const it of body.items) {
        if (cursorAll.includes(it.id)) dup = true;
        cursorAll.push(it.id);
      }
      if (!body.meta.hasNext) break;
      cur = body.meta.nextCursor;
    }
    const sameSet = offsetAll.length === cursorAll.length
      && offsetAll.every((id) => cursorAll.includes(id));
    check("커서: 검색 결과 전체 순회 = 오프셋 전체 결과와 동일 집합(중복·누락 없음)",
      sameSet && !dup, "offset=" + offsetAll.length + ", cursor=" + cursorAll.length);
  }
  {
    const { body } = await get("/api/posts/cursor?search=zzz없는검색어");
    check("커서: 결과 0건 → items=[], hasNext=false, nextCursor=null",
      body.items.length === 0 && body.meta.hasNext === false && body.meta.nextCursor === null,
      JSON.stringify(body.meta));
  }
  {
    const { body } = await get("/api/posts/cursor?cursor=abc&limit=5");
    check("커서 방어: cursor=abc → 무시하고 처음부터", body.items[0].id === 1000);
  }
  {
    const { body } = await get("/api/posts/cursor?cursor=-10&limit=5");
    check("커서 방어: cursor=-10 → 무시하고 처음부터", body.items[0].id === 1000);
  }
  {
    const { body } = await get("/api/posts/cursor?limit=9999");
    check("커서 방어: limit 상한 50", body.meta.limit === 50 && body.items.length === 50);
  }
  {
    const { body } = await get("/api/posts/cursor?cursor=10&limit=10");
    check("커서: 마지막 배치 이후 nextCursor 계약 (hasNext=false일 때 null)",
      body.meta.hasNext === false && body.meta.nextCursor === null,
      JSON.stringify(body.meta));
  }

  // ===== 3. 비동기(서버 측에서 검증 가능한 부분) =====
  {
    // 동시 다발 요청이 서로를 오염시키지 않는지 (서버 무상태 확인)
    const reqs = await Promise.all([
      get("/api/posts?search=파스타&limit=5"),
      get("/api/posts?search=초밥&limit=5"),
      get("/api/posts?search=티라미수&limit=5"),
    ]);
    const ok =
      reqs[0].body.meta.search === "파스타" &&
      reqs[1].body.meta.search === "초밥" &&
      reqs[2].body.meta.search === "티라미수" &&
      reqs[0].body.items.every((p) => (p.title + p.content).includes("파스타"));
    check("비동기: 병렬 요청 3건 → 각 응답 meta.search가 요청과 일치(혼선 없음)", ok);
  }
  {
    // AbortController 서버측 동작: 클라이언트가 중단해도 서버가 죽지 않아야 함
    const ac = new AbortController();
    const p = fetch(BASE + "/api/posts?limit=100", { signal: ac.signal }).catch((e) => e.name);
    ac.abort();
    const name = await p;
    const after = await get("/api/posts?limit=1");
    check("비동기: 요청 Abort 후에도 서버 정상 응답", name === "AbortError" && after.status === 200);
  }

  // ===== 결과 출력 =====
  console.log("\n================ 테스트 결과 ================");
  for (const r of results) {
    console.log((r.status === "PASS" ? "✅ PASS" : "❌ FAIL") + " | " + r.name
      + (r.status === "FAIL" && r.detail ? "\n         → " + r.detail : ""));
  }
  console.log("=============================================");
  console.log("합계: " + (passed + failed) + "건 중 PASS " + passed + " / FAIL " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("테스트 실행 실패(서버가 꺼져 있나요?):", e.message);
  process.exit(2);
});
