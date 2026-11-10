/**
 * 웹서비스설계 9주차 응용 · 맛집 후기 게시판 (단일 파일 서버 + 화면)
 *
 * 9주차 실습 패키지를 참고해 직접 구현한 검색·정렬·페이지네이션 게시판입니다.
 *   1) 방어적 파라미터 파싱 (parseInt 10진수, 음수·0 차단, limit 상한)
 *   2) 정렬 화이트리스트 사전 매핑 (Injection 방어, id DESC 동점자 2차 정렬)
 *   3) 오프셋 페이징 API (/api/posts) + 표준 { items, meta } Envelope
 *   4) 커서 기반(Keyset) 페이징 API (/api/posts/cursor, limit+1 패턴)
 *   5) X-Response-Time 헤더로 오프셋 vs 커서 처리 시간 비교
 *
 * 실행 방법:
 *   1) npm install express
 *   2) node server.js
 *   3) 브라우저에서 http://localhost:3000 접속
 */

const express = require("express");
const app = express();
const PORT = 3000;

// ==========================================
// 1,000건의 맛집 후기 더미 데이터 (id 1000 → 1)
// ==========================================
const PLACES = [
  "전주 막걸리골목", "객사길 파스타집", "덕진공원 카페", "신시가지 초밥집",
  "한옥마을 비빔밥", "모래내시장 칼국수", "효자동 고깃집", "송천동 쌀국숫집",
];
const MENUS = [
  "들깨칼국수", "숙성 삼겹살", "연어 초밥", "트러플 크림 파스타",
  "육회비빔밥", "콩나물국밥", "분짜와 고이꾸온", "수제 티라미수",
];
const AUTHORS = ["승연", "지우", "민준", "서연", "하린", "도윤", "예은", "시우"];

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const place = PLACES[i % PLACES.length];
  const menu = MENUS[(i * 3) % MENUS.length];
  return {
    id,
    title: "[" + place + "] " + menu + " 후기 #" + id,
    content:
      place + "에서 " + menu + "을(를) 먹었습니다. " +
      "웨이팅, 가격, 맛 평가를 기록한 " + id + "번째 후기입니다.",
    author: AUTHORS[i % AUTHORS.length],
    views: ((id * 37) % 4800) + 12,
    createdAt:
      "2026-" +
      String(10 - Math.floor(i / 150)).padStart(2, "0") +
      "-" +
      String((i % 28) + 1).padStart(2, "0"),
  };
});

// ==========================================
// 정렬 화이트리스트: 허용된 키만 비교 함수로 매핑한다.
// 조회수처럼 동점이 나는 키는 id DESC를 2차 정렬로 결합해
// 페이지 사이 중복·누락을 막는다. 미허용 키는 latest로 격리.
// ==========================================
const SORT_WHITELIST = Object.freeze({
  latest: (a, b) => b.id - a.id,
  oldest: (a, b) => a.id - b.id,
  views: (a, b) => (b.views !== a.views ? b.views - a.views : b.id - a.id),
});

// 서버 처리 시간(ms): X-Response-Time 헤더와 meta로 노출한다.
function elapsedMs(start) {
  const d = process.hrtime(start);
  return Number((d[0] * 1000 + d[1] / 1e6).toFixed(2));
}

// 검색 필터: 제목·내용 부분 일치(소문자 비교)
function filterBySearch(search) {
  if (!search) return POSTS;
  const kw = search.toLowerCase();
  return POSTS.filter(
    (p) =>
      p.title.toLowerCase().includes(kw) ||
      p.content.toLowerCase().includes(kw),
  );
}

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=파스타
// ==========================================
app.get("/api/posts", (req, res) => {
  const startTime = process.hrtime();

  // 방어적 파라미터 파싱: 잘못된 값은 400 대신 안전한 기본값으로 격리
  const rawPage = parseInt(req.query.page, 10);
  const rawLimit = parseInt(req.query.limit, 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 10;
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";
  const sort = Object.hasOwn(SORT_WHITELIST, req.query.sort ?? "")
    ? req.query.sort
    : "latest";

  // WHERE → ORDER BY → LIMIT/OFFSET 순서로 처리
  const filtered = [...filterBySearch(search)].sort(SORT_WHITELIST[sort]);
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages); // 범위 밖 페이지는 마지막 페이지로
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader("X-Response-Time", executionTimeMs + "ms");
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      sort,
      search,
      executionTimeMs,
    },
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10&search=초밥
// WHERE id < ? ORDER BY id DESC LIMIT n+1 → COUNT(*) 없이 hasNext 판단
// ==========================================
app.get("/api/posts/cursor", (req, res) => {
  const startTime = process.hrtime();

  const rawCursor = parseInt(req.query.cursor, 10);
  const cursor =
    Number.isInteger(rawCursor) && rawCursor > 0 ? rawCursor : null;
  const rawLimit = parseInt(req.query.limit, 10);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";

  let candidate = filterBySearch(search); // POSTS는 이미 id DESC 순서
  if (cursor) candidate = candidate.filter((p) => p.id < cursor);

  // limit+1개를 조회해 다음 구간 존재 여부를 판단한다.
  const sliced = candidate.slice(0, limit + 1);
  const hasNext = sliced.length > limit;
  const items = hasNext ? sliced.slice(0, limit) : sliced;

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader("X-Response-Time", executionTimeMs + "ms");
  res.json({
    items,
    meta: {
      cursor,
      // hasNext=false면 다음 요청이 무의미하므로 null로 계약을 명확히 한다.
      nextCursor: hasNext && items.length ? items[items.length - 1].id : null,
      limit,
      hasNext,
      search,
      executionTimeMs,
    },
  });
});

// ==========================================
// 3. 단일 파일 화면 (SPA)
// 디바운스 300ms · AbortController · URLSearchParams 히스토리 동기화
// ==========================================
const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>맛집 후기 게시판 · 9주차 응용</title>
<style>
  :root {
    --primary: #2455ad; --soft: #e9eef7; --ink: #17233a;
    --muted: #61718a; --line: #dfe5ee; --bg: #f2f5f9; --ok: #0d8a4f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 16px; background: var(--bg); color: var(--ink);
    font-family: system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  .card {
    background: #fff; border: 1px solid var(--line); border-radius: 14px;
    padding: 22px; margin-bottom: 18px;
  }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.03em; }
  .muted { color: var(--muted); font-size: 14px; }
  .tab-bar { display: flex; gap: 8px; margin: 16px 0 12px; }
  button {
    background: var(--primary); color: #fff; border: 0; border-radius: 7px;
    padding: 9px 14px; font: inherit; font-size: 14px; cursor: pointer;
  }
  button.secondary { background: var(--soft); color: #27416c; }
  button:disabled { opacity: 0.5; cursor: default; }
  .controls { display: flex; gap: 8px; margin-bottom: 12px; }
  .controls input {
    flex: 1; border: 1px solid #b9c5d6; border-radius: 7px;
    padding: 10px 12px; font: inherit;
  }
  .controls select {
    border: 1px solid #b9c5d6; border-radius: 7px; padding: 10px; font: inherit;
    background: #fff;
  }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left; background: #f6f8fb; color: var(--muted);
    padding: 9px 12px; border-bottom: 2px solid var(--line); font-weight: 600;
  }
  td { padding: 10px 12px; border-bottom: 1px solid #edf0f5; }
  td.id { color: var(--primary); font-weight: 700; width: 64px; }
  td.views { color: var(--primary); width: 76px; }
  td.date { color: var(--muted); width: 100px; }
  td.author { width: 72px; }
  .paging { display: flex; justify-content: center; gap: 6px; margin-top: 16px; flex-wrap: wrap; }
  .paging button { padding: 6px 11px; font-size: 13px; }
  .more { display: flex; justify-content: center; margin-top: 16px; }
  .inspector { font: 12.5px/1.6 Consolas, Menlo, monospace; }
  .inspector .row { margin-bottom: 8px; word-break: break-all; }
  .inspector b { color: var(--primary); }
  .badge {
    font: 700 12px Consolas, monospace; background: #e6f7ef; color: var(--ok);
    border-radius: 4px; padding: 2px 8px; margin-left: 8px;
  }
  .empty { text-align: center; color: var(--muted); padding: 28px 0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>오늘의 맛집 후기 <span class="badge" id="latency">-</span></h1>
    <p class="muted">
      1,000건 데이터셋 · 검색(300ms 디바운스) · 정렬 화이트리스트 ·
      오프셋 vs 커서 페이징 · 뒤로 가기 상태 복원
    </p>
    <div class="tab-bar">
      <button id="tabOffset">오프셋 번호 페이징 (LIMIT/OFFSET)</button>
      <button id="tabCursor" class="secondary">커서 기반 더보기 (id &lt; ?)</button>
    </div>
    <div class="controls">
      <input id="searchInput" type="search" placeholder="제목·내용 검색 (300ms 디바운스)">
      <select id="sortSelect">
        <option value="latest">최신순</option>
        <option value="views">조회수순</option>
        <option value="oldest">오래된순</option>
      </select>
    </div>
    <table>
      <thead>
        <tr><th>번호</th><th>제목</th><th>작성자</th><th>조회수</th><th>작성일</th></tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="paging" id="paging"></div>
    <div class="more" id="moreWrap" style="display:none;">
      <button id="btnMore">다음 10개 더 불러오기 (Keyset)</button>
    </div>
  </div>
  <div class="card inspector">
    <div class="row"><b>요청 URL</b> <span id="inspectUrl">-</span></div>
    <div class="row"><b>응답 meta</b> <span id="inspectMeta">-</span></div>
  </div>
</div>
<script>
  var mode = "offset";
  var state = { page: 1, limit: 10, sort: "latest", search: "", cursor: null, hasNext: true };
  var cursorPosts = [];
  var controller = null;
  var debounceTimer = null;

  function el(id) { return document.getElementById(id); }

  function switchMode(next) {
    mode = next;
    el("tabOffset").className = mode === "offset" ? "" : "secondary";
    el("tabCursor").className = mode === "cursor" ? "" : "secondary";
    el("paging").style.display = mode === "offset" ? "flex" : "none";
    el("moreWrap").style.display = mode === "cursor" ? "flex" : "none";
    el("sortSelect").disabled = mode === "cursor"; // 커서는 최신순 고정
    state.page = 1;
    state.cursor = null;
    cursorPosts = [];
    loadData(mode === "offset");
  }

  // 데이터 로드: 이전 진행 중인 요청은 AbortController로 취소한다.
  function loadData(pushHistory) {
    if (controller) controller.abort();
    controller = new AbortController();
    var myController = controller; // 늦게 도착한(이미 파싱 완료된) 응답의 덮어쓰기 방지용

    var endpoint;
    if (mode === "offset") {
      var q = new URLSearchParams({ page: state.page, limit: state.limit, sort: state.sort });
      if (state.search) q.set("search", state.search);
      endpoint = "/api/posts?" + q.toString();
      // 주소창 동기화: 뒤로 가기·새로고침 시 상태 복원용
      if (pushHistory && location.search !== "?" + q.toString()) {
        history.pushState(null, "", "?" + q.toString());
      }
    } else {
      var q2 = new URLSearchParams({ limit: state.limit });
      if (state.search) q2.set("search", state.search);
      if (state.cursor) q2.set("cursor", state.cursor);
      endpoint = "/api/posts/cursor?" + q2.toString();
    }
    el("inspectUrl").textContent = "GET " + endpoint;

    fetch(endpoint, { signal: controller.signal })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        // abort()가 json 파싱 완료 직후에 호출되면 이 콜백은 취소되지 않는다.
        if (myController !== controller) return;
        el("latency").textContent = json.meta.executionTimeMs + "ms";
        el("inspectMeta").textContent = JSON.stringify(json.meta);
        if (mode === "offset") {
          renderTable(json.items);
          renderPaging(json.meta.page, json.meta.totalPages);
          state.page = json.meta.page; // 서버가 보정한 페이지로 동기화
          // 서버가 범위 밖 page를 보정했으면 주소창도 실제 표시 상태로 맞춘다.
          var canon = new URLSearchParams({ page: state.page, limit: state.limit, sort: state.sort });
          if (state.search) canon.set("search", state.search);
          if (location.search && location.search !== "?" + canon.toString()) {
            history.replaceState(null, "", "?" + canon.toString());
          }
        } else {
          if (!state.cursor) cursorPosts = [];
          cursorPosts = cursorPosts.concat(json.items);
          state.cursor = json.meta.nextCursor;
          state.hasNext = json.meta.hasNext;
          renderTable(cursorPosts);
          el("btnMore").disabled = !state.hasNext;
          el("btnMore").textContent = state.hasNext
            ? "다음 10개 더 불러오기 (Keyset)"
            : "더 이상 글이 없습니다";
        }
      })
      .catch(function (err) {
        if (err.name === "AbortError") {
          console.log("[AbortController] 이전 비동기 요청이 정상 취소되었습니다.");
        } else {
          console.error("Fetch error:", err);
        }
      });
  }

  // 응답 데이터를 innerHTML에 넣기 전 이스케이프 (XSS 방어)
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderTable(items) {
    var tb = el("tbody");
    if (!items || items.length === 0) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">검색 조건에 일치하는 글이 없습니다.</td></tr>';
      return;
    }
    tb.innerHTML = items
      .map(function (p) {
        return (
          "<tr><td class='id'>" + p.id + "</td><td>" + esc(p.title) +
          "</td><td class='author'>" + esc(p.author) +
          "</td><td class='views'>" + p.views.toLocaleString() +
          "</td><td class='date'>" + esc(p.createdAt) + "</td></tr>"
        );
      })
      .join("");
  }

  function renderPaging(page, totalPages) {
    var html = "";
    var start = Math.max(1, page - 3);
    var end = Math.min(totalPages, page + 3);
    if (page > 1) {
      html += '<button class="secondary" onclick="goToPage(1)">&laquo;</button>';
      html += '<button class="secondary" onclick="goToPage(' + (page - 1) + ')">&lsaquo;</button>';
    }
    for (var i = start; i <= end; i++) {
      html +=
        '<button class="' + (i === page ? "" : "secondary") + '" ' +
        (i === page ? "disabled " : "") +
        'onclick="goToPage(' + i + ')">' + i + "</button>";
    }
    if (page < totalPages) {
      html += '<button class="secondary" onclick="goToPage(' + (page + 1) + ')">&rsaquo;</button>';
      html += '<button class="secondary" onclick="goToPage(' + totalPages + ')">&raquo;</button>';
    }
    el("paging").innerHTML = html;
  }

  function goToPage(p) {
    state.page = p;
    loadData(true);
  }

  // 300ms 디바운스: 타이핑이 멈춘 뒤 한 번만 요청한다.
  el("searchInput").addEventListener("input", function (e) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      state.search = e.target.value.trim();
      state.page = 1;
      state.cursor = null;
      loadData(mode === "offset");
    }, 300);
  });

  el("sortSelect").addEventListener("change", function (e) {
    state.sort = e.target.value;
    state.page = 1;
    loadData(true);
  });

  el("tabOffset").addEventListener("click", function () { switchMode("offset"); });
  el("tabCursor").addEventListener("click", function () { switchMode("cursor"); });
  el("btnMore").addEventListener("click", function () {
    if (state.hasNext) loadData(false);
  });

  // 주소창 → 상태 복원 (뒤로 가기, 새로고침, URL 공유)
  function restoreFromUrl() {
    var params = new URLSearchParams(location.search);
    var p = parseInt(params.get("page"), 10);
    state.page = Number.isInteger(p) && p > 0 ? p : 1;
    state.sort = ["latest", "views", "oldest"].indexOf(params.get("sort")) >= 0
      ? params.get("sort") : "latest";
    state.search = params.get("search") || "";
    el("searchInput").value = state.search;
    el("sortSelect").value = state.sort;
  }
  window.addEventListener("popstate", function () {
    mode = "offset"; // 주소창 상태는 오프셋 모드의 것
    state.cursor = null;
    restoreFromUrl();
    switchModeUiOnly();
    loadData(false);
  });
  function switchModeUiOnly() {
    el("tabOffset").className = "";
    el("tabCursor").className = "secondary";
    el("paging").style.display = "flex";
    el("moreWrap").style.display = "none";
    el("sortSelect").disabled = false;
  }
  restoreFromUrl();
  loadData(false);
</script>
</body>
</html>`;

app.get("/", (_, res) => res.type("html").send(PAGE));

app.listen(PORT, () => {
  console.log("====================================================");
  console.log("🍜 맛집 후기 게시판 (9주차 응용 · 단일 파일) 서버 구동");
  console.log("📡 URL: http://localhost:" + PORT);
  console.log("📦 데이터: 1,000건의 인메모리 후기 로드 완료");
  console.log("====================================================");
});
