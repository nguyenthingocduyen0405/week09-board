# 맛집 후기 게시판 — 9주차 응용 (검색 · 정렬 · 페이지네이션)

1,000건의 인메모리 더미 데이터를 대상으로 **검색(300ms 디바운스) · 정렬 화이트리스트 · 오프셋/커서 페이지네이션 · URL 상태 동기화**를 구현한 단일 파일(Express) 실습 프로젝트입니다.

## 요구 환경

- Node.js **18 이상** (전역 fetch 사용 · v24에서 동작 확인)
- 의존성: `express ^5.3.0` 단 1개 (그 외 외부 라이브러리 없음)

## 설치 및 실행

```bash
npm install          # express 설치
npm start            # 서버 시작 (= node server.js)
```

브라우저에서 **http://localhost:3000** 접속. 종료는 터미널에서 `Ctrl + C`.

```bash
npm test             # (서버 실행 상태에서) API 자동 회귀 테스트 36건 (= node test.js)
```

## 파일 구성

| 파일 | 설명 |
|---|---|
| `server.js` | Express 서버 + API 2종 + SPA 화면(단일 파일) |
| `test.js` | 의존성 없는 API 자동 테스트 (Node 18+ 전역 fetch) |
| `report.md` | 실습 보고서 — **로컬 보관(저장소 비포함)**. 테스트 매트릭스·수정 내역·개념 설명·AI 활용 공개 |
| `TEST_CHECKLIST.md` | 테스트 증빙 및 브라우저 검증 결과·재현 절차 |
| `docs/screenshots/` | 테스트 캡처 ①~⑨ (실제 Chrome 구동 촬영) |
| `docs/test-output.txt` | `node test.js` 원본 출력 (36/36 PASS) |

## API

### 1) 오프셋 페이지네이션 — `GET /api/posts`

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `page` | 1 | 1 이상 정수. 잘못된 값은 1로, 범위 밖은 마지막 페이지로 보정 |
| `limit` | 10 | 1~100. 초과 시 100으로 상한 |
| `sort` | `latest` | `latest` \| `oldest` \| `views` 화이트리스트. 그 외(`constructor` 등 상속 프로퍼티 포함)는 `latest` 폴백 |
| `search` | (없음) | 제목·내용 부분 일치, 대소문자 무시, 최대 100자 |

```bash
curl "http://localhost:3000/api/posts?page=2&limit=10&sort=views&search=파스타"
```

```json
{
  "items": [ { "id": 996, "title": "...", "content": "...", "author": "...", "views": 123, "createdAt": "2026-10-05" } ],
  "meta": { "page": 2, "limit": 10, "totalCount": 125, "totalPages": 13,
            "hasNext": true, "hasPrev": true, "sort": "views", "search": "파스타",
            "executionTimeMs": 0.42 }
}
```

### 2) 커서(Keyset) 페이지네이션 — `GET /api/posts/cursor`

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `cursor` | (없음) | 마지막으로 받은 글의 id. `id < cursor` 조건으로 다음 구간 조회. 잘못된 값은 무시(처음부터) |
| `limit` | 10 | 1~50. 초과 시 50으로 상한 |
| `search` | (없음) | 오프셋 API와 동일한 검색 (커서 필터보다 먼저 적용) |

정렬은 **id 내림차순(최신순) 고정**입니다. `limit + 1`건을 조회해 `hasNext`를 판단하며, `hasNext=false`이면 `nextCursor`는 `null`입니다.

```bash
curl "http://localhost:3000/api/posts/cursor?cursor=991&limit=10&search=초밥"
```

```json
{
  "items": [ ... ],
  "meta": { "cursor": 991, "nextCursor": 981, "limit": 10, "hasNext": true,
            "search": "초밥", "executionTimeMs": 0.15 }
}
```

### 3) 화면 — `GET /`

- **검색창**: 300ms 디바운스 → 타이핑이 멈춘 뒤 1회만 요청. 이전 미완료 요청은 `AbortController`로 취소.
- **정렬 셀렉트**: 최신순/조회수순/오래된순. 커서 모드에서는 비활성화(최신순 고정).
- **오프셋 모드**: 번호 페이징. `page`·`sort`·`search`가 주소창 쿼리스트링과 동기화되어 새로고침·뒤로/앞으로 가기·URL 공유 시 상태 복원.
- **커서 모드**: "더 불러오기" 누적 로딩. 검색어 변경 시 누적 목록·커서 초기화, 마지막 배치 이후 버튼 비활성화.

모든 응답에 `X-Response-Time` 헤더와 `meta.executionTimeMs`로 서버 처리 시간이 포함됩니다.

## 사용 예 (화면)

1. `http://localhost:3000` 접속 → 최신순 1페이지 표시
2. 검색창에 "티라미수" 입력 → 300ms 후 자동 검색, 1페이지로 리셋
3. 정렬을 "조회수순"으로 변경 → 1페이지로 리셋, URL 갱신
4. 페이지 이동 후 **새로고침/뒤로 가기** → 동일 상태 복원
5. "커서 기반 더보기" 탭 → "다음 10개 더 불러오기"로 누적 로딩
