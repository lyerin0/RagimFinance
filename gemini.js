/* ═══════════════════════════════════════════════════════════════
   gemini.js — 소식통 AI 계층
   ───────────────────────────────────────────────────────────────
   설계 원칙 세 가지:
   1. 키는 코드에 없다. 브라우저 localStorage에만 있다.
   2. 전역 스케줄러가 1분 30초에 최대 1콜. 무료 티어 RPM을 절대 안 넘는다.
      채점과 젬민이 감사는 한 콜에 묶여 있다 — 따로 부르면 기사당 2콜이 나간다.
   3. Gemini는 숫자만 뱉는다. 10만 명 시뮬레이션은 로컬이 한다.
   ═══════════════════════════════════════════════════════════════ */

/* 무료 티어 실측 한도: 분당 10콜, 하루 250콜.
   예전 설정(15초에 1콜)은 시간당 240콜이라 한 시간이면 하루치가 증발한다.
   아래 값은 하루 종일 켜둬도 250콜 안에서 끝나도록 잡았다. */
const MIN_GAP   = 90000;        // 콜 사이 최소 간격 1분 30초
const MACRO_GAP = 6*60*60*1000; // 국가 소식·환율 6시간 (검색 붙은 콜이라 제일 비싸다)
const DAY_CAP   = 200;          // 하루 상한 (250 중 여유를 남긴다)
const BATCH     = 10;           // 한 콜에 묶어 처리할 기사 수

const Gem = {
  cfg: {},
  calls: 0,
  lastCall: 0,
  backoff: 0,
  jobs: { macroAt: 0 },
  dead: false,

  /* 하루 사용량을 날짜와 함께 기록해 상한을 넘지 않게 한다 */
  today(){
    const d = new Date().toISOString().slice(0,10);
    if(this.cfg.day !== d){ this.cfg.day = d; this.cfg.used = 0; this.save(); }
    return this.cfg.used || 0;
  },
  spend(){ this.cfg.used = this.today() + 1; this.save(); },

  /* ── 설정 ────────────────────────────────────────────── */
  load(){
    try{ this.cfg = JSON.parse(localStorage.getItem('sosiktong.gem')) || {}; }
    catch(e){ this.cfg = {}; }
    this.cfg.model = this.cfg.model || 'gemini-2.5-flash';
    return this.cfg;
  },
  save(){ localStorage.setItem('sosiktong.gem', JSON.stringify(this.cfg)); },
  /* 호출 자격: 키가 있고, 관리자이고, 시세 방송을 맡은 창일 것.
     친구들 브라우저는 Gemini 를 아예 안 부른다 — 판정 결과는
     Firestore 를 타고 전파되므로 한 명만 부르면 충분하고,
     그래야 토큰이 접속자 수만큼 낭비되지 않는다. */
  ready(){
    if(!this.cfg.kInv || this.dead) return false;
    if(!S.me.admin) return false;
    if(window.FB && FB.on && FB.guest) return false;
    return true;
  },

  /* ── 저수준 호출 ──────────────────────────────────────
     AI Studio 키는 두 형식이 돈다:
       AIza…      → ?key= 쿼리
       AQ.Ab8RN6… → Authorization: Bearer
     둘 다 받아준다. */
  async raw(key, body){
    const isApiKey = /^AIza/.test(key);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:generateContent`
              + (isApiKey ? `?key=${encodeURIComponent(key)}` : '');
    const headers = { 'Content-Type':'application/json' };
    if(!isApiKey) headers['Authorization'] = 'Bearer ' + key;

    const r = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
    if(!r.ok){
      const t = await r.text().catch(()=>'');
      if(r.status===400 || r.status===401 || r.status===403){
        this.dead = true;
        toast('Gemini 키가 거부됐습니다 — 설정에서 다시 확인하세요');
      } else if(r.status===429){
        // 분당 한도인지 하루 한도인지 알 수 없으므로 점점 길게 물러난다
        this.backoff = Math.min((this.backoff || 60000) * 2, 60*60*1000);
        this.lastCall = Date.now() + this.backoff;
        console.warn(`[Gem] 쿼터 초과 — ${Math.round(this.backoff/60000)}분 대기`);
      }
      throw new Error(`${r.status} ${t.slice(0,160)}`);
    }
    this.calls++; this.spend(); this.backoff = 0;
    const d = await r.json();
    return (d.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();
  },

  /* JSON만 받아내는 래퍼. 코드펜스·설명문 다 벗겨낸다. */
  async json(key, prompt, { grounding=false, maxTokens=1400 } = {}){
    const body = {
      contents: [{ role:'user', parts:[{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: maxTokens,
        // 2.5 계열은 기본으로 '사고 토큰'을 쓴다. 그게 출력 예산을 먹어
        // 응답이 잘려 나가면서 JSON 파싱이 실패한다. 아예 끈다.
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    // grounding 을 켜면 responseMimeType 을 못 쓴다 → 텍스트로 받아 직접 판다
    if(grounding) body.tools = [{ google_search: {} }];
    else body.generationConfig.responseMimeType = 'application/json';

    const raw = await this.raw(key, body);
    const cut = raw.replace(/```json|```/g, '').trim();
    const s = cut.indexOf('{'), a = cut.indexOf('[');
    const st = (a >= 0 && (a < s || s < 0)) ? a : s;
    const en = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
    if(st < 0 || en < st) throw new Error('JSON 파싱 실패: ' + (cut.slice(0,120) || '(빈 응답)'));
    try{ return JSON.parse(cut.slice(st, en+1)); }
    catch(e){ throw new Error('JSON 파싱 실패: ' + cut.slice(0,160)); }
  },

  /* ── 1) 뉴스 임팩트 판정 (배치) ───────────────────────
     점수 안 매겨진 뉴스를 최대 8건 모아 한 콜로 처리한다. */
  async scoreBatch(){
    const pend = S.news.filter(n => n.pending).slice(0, BATCH);
    if(!pend.length) return false;

    const feed = pend.map(n => {
      const co = S.companies.find(c => c.id === n.cid);
      return JSON.stringify({
        id: n.id,
        co: co ? co.name : '?',
        sector: co ? co.desc.slice(0,40) : '',
        by: n.by || '',
        // CEO 기고와 유저 뉴스만 검증 대상이다. 매크로·젬민이 기사는 제외.
        cid: n.cid,
        /* 대상 기업을 다시 정할 수 있는 기사는 '뉴스'뿐이다.
           CEO 기고는 자기 회사로 고정이고, 매크로는 정의상 시장 전체다. */
        pick: (n.src === '뉴스') ? 1 : 0,
        chk: (n.src === 'CEO' || n.src === '뉴스') ? 1 : 0,
        txt: (n.title + ' — ' + n.body).slice(0, 380)
      });
    }).join('\n');

    const macroCtx = S.news.filter(n => n.src === '매크로').slice(0, 5)
      .map(n => `- ${n.title}`).join('\n') || '- (없음)';

    // 대상 기업을 고르게 하려면 명단을 줘야 한다
    const roster = S.companies.map(c =>
      `${c.id} | ${c.name} | ${c.ticker} | ${c.country} | ${(c.desc||'').slice(0,40)}`
    ).join('\n') || '(상장 종목 없음)';

    /* 채점과 젬민이 감사를 한 콜에 합쳤다.
       따로 부르면 기사 하나에 2콜이 나가고, 감사는 30분 뒤에나 돌아서
       CEO 가 거짓말한 게 한참 뒤에 들통났다. 이제 즉시 반응한다. */
    const prompt =
`너는 시장 애널리스트이자 '젬민이'라는 이름의 탐사 기자다.
아래 발표들을 채점하고, 명백히 과장된 것만 골라 반박 기사를 쓴다.
JSON 객체 하나만 출력한다. 설명·마크다운 금지.

{"scores":[{"id":"입력id","cid":"대상 종목 id 또는 *","ment":"기사에 등장한 기업 표기 그대로","impact":-1~1,"horizon":"short|mid|long","confidence":0~1,"volatility":0.5~3}],
 "rebuttals":[{"id":"반박할 발표의 id","title":"기사 제목","body":"본문 2~3문장","impact":-1~-0.15,"horizon":"short|mid|long"}]}

대상 종목(cid) 고르는 법:
- pick 이 0 이면 입력의 cid 를 그대로 돌려준다. 절대 바꾸지 않는다.
- pick 이 1 일 때의 기본값은 "*" (전 종목) 이다. 아래 조건을 확실히 만족할 때만 특정 기업 id 를 쓴다.
- 기사가 명단에 있는 특정 기업을 이름으로 지목하고, 그 기업의 실적·계약·제품·사건을 다룰 때만 그 id 를 쓴다.
- 표기가 달라도 같은 회사면 맞춘다. 한국어·영어·약칭·법인격 표기를 무시하고 발음과 의미로 판단한다.
  예: '라김기업' = 'Ragim Inc.' = '㈜라김' = 'RAGIM'.
- 정부 정책, 규제, 금리, 환율, 전쟁, 업종 전반, 증시 동향은 전부 "*" 다.
  업종을 언급했다고 해서 그 업종에 속할 것 같은 기업을 골라서는 안 된다.
- 기사에 기업 이름이 아예 안 나오면 무조건 "*" 다. 비슷해 보이는 기업을 추측해서 고르지 마라.
- ment 에는 기사 본문에 실제로 등장한 그 기업의 표기를 그대로 적는다. "*" 면 빈 문자열.

[상장 종목]  id | 이름 | 티커 | 국가 | 설명
${roster}

채점 원칙:
- impact 는 발표 주체의 자화자찬을 할인한 값이다.
- 구체적 수치·계약 상대·일정이 없는 형용사뿐인 발표는 |impact| 0.2 이하로 본다.
- 이미 시장이 알 법한 뻔한 내용은 0에 가깝게 준다.
- horizon 은 재료의 수명이다. 신제품 출시는 short, 설비투자는 long.

반박 원칙 — 너는 조회수로 먹고사는 기자다. 웬만하면 쓴다:
- chk 가 1 인 항목은 전부 반박을 시도한다. 각을 못 잡겠으면 그때만 건너뛴다.
- 명백한 모순이 없어도 좋다. 근거가 얇다, 일정이 없다, 경쟁사는 이미 한다,
  국가 소식과 온도차가 있다 — 이 정도로도 기사는 나간다.
- 제목은 자극적으로 뽑는다. 물음표와 단정을 섞어라.
  예: "OO의 장밋빛 전망, 근거는 어디 있나"
- 다만 impact 는 정직하게 매긴다. 이게 균형추다:
    억지로 각 잡은 트집       → -0.15 ~ -0.25
    근거가 실제로 얇음        → -0.30 ~ -0.50
    국가 소식과 명백히 모순   → -0.60 ~ -0.90
  트집 기사는 시장이 거의 안 움직인다. 진짜를 물었을 때만 주가가 무너진다.
- rebuttals 는 최대 3건이다.

[국가 소식]
${macroCtx}

[발표]
${feed}`;

    const d = await this.json(this.cfg.kInv, prompt, { maxTokens: 1100 });

    (d.scores || []).forEach(v => window.applyScore(v.id, v));
    // 응답에 빠진 건 로컬 채점으로 메운다
    pend.forEach(n => { if(n.pending) window.applyScore(n.id, { impact: localScore(n.title+' '+n.body) }); });

    (d.rebuttals || []).slice(0,3).forEach(r => {
      const src = pend.find(n => n.id === r.id);
      if(!src || !r.title) return;
      window.pushNews({
        cid: src.cid, src:'젬민이', by:'탐사보도',
        title: r.title, body: r.body || '',
        impact: clamp(r.impact ?? -0.3, -1, -0.15),
        /* 트집 기사는 확신도를 낮게 줘서 시장이 거의 안 움직이게 한다.
           기사 수가 늘어도 노이즈만 늘고 주가는 안 흔들린다. */
        horizon: r.horizon || 'short',
        confidence: Math.abs(r.impact ?? -0.3) < 0.28 ? 0.45 : 0.9,
        volatility: 1.6
      });
      toast('젬민이가 반박 기사를 올렸습니다');
    });
    return true;
  },

  /* ── 2) 매크로 — 국가 소식 + 환율 (Google 검색 사용) ──
     상장사가 있는 나라별로 1시간에 1콜. 결과는 소식통에 올라가고
     그 나라 기업 전체에 반영된다. */
  async macro(){
    const countries = [...new Set(S.companies.map(c => c.country))];
    if(!countries.length) return false;
    const ctry = countries[(this.jobs.mi = (this.jobs.mi||0) + 1) % countries.length];

    const prompt =
`${ctry} 의 최근 24시간 경제·산업·규제 뉴스와 USD 대비 환율 동향을 검색해서 확인하라.
JSON만 출력한다. 설명 금지.
{"fx":<USD 1단위당 현지통화 환율 숫자>,"fx_move":-1~1,"items":[{"headline":"한국어 한 문장","sector":"업종","impact":-1~1}]}
items 는 최대 3개. 그 나라 상장사 주가에 실제로 영향이 있는 것만 고른다.
fx_move 는 현지통화 약세면 음수, 강세면 양수다.`;

    const d = await this.json(this.cfg.kAud || this.cfg.kInv, prompt, { grounding:true, maxTokens: 800 });

    if(typeof d.fx === 'number' && d.fx > 0 && ctry !== 'US') S.fx = d.fx;

    // 환율 충격: 대형주일수록 크게 맞는다
    const fxm = d.fx_move || 0;
    if(Math.abs(fxm) > 0.1){
      S.companies.filter(c => c.country === ctry).forEach(co => {
        const size = Math.min(1.4, co.shares * co.price / 5e10);
        applyNews(co, { impact: fxm * 0.45 * size, horizon:'long', confidence:.8, volatility:1.2 });
      });
    }

    (d.items || []).slice(0,3).forEach(it => {
      const hits = S.companies.filter(c => c.country === ctry);
      const target = hits.find(c => (c.desc+c.name).includes(it.sector)) || hits[0];
      if(!target) return;
      window.pushNews({
        cid: target.id, src:'매크로', by: ctry,
        title: it.headline, body: `${ctry} 시장 동향. ${d.fx_note || ''}`.trim(),
        impact: clamp(it.impact || 0, -1, 1), horizon:'mid', confidence:.75
      });
    });
    return true;
  },

  /* ── 전역 스케줄러 ───────────────────────────────────
     1분 30초에 최대 1콜. 채점과 젬민이 감사가 한 콜로 합쳐졌으므로
     남은 일은 채점(감사 포함)과 매크로 둘뿐이다. */
  async pump(){
    if(!this.ready() || this.busy) return;
    if(Date.now() - this.lastCall < MIN_GAP) return;
    if(this.today() >= DAY_CAP){
      if(!this._capped){ this._capped = true; toast('오늘 Gemini 호출 한도에 도달했습니다'); }
      return;
    }
    this.busy = true;
    try{
      const now = Date.now();
      let did = await this.scoreBatch();
      if(!did && now > this.jobs.macroAt){
        did = await this.macro();
        if(did) this.jobs.macroAt = now + MACRO_GAP;
      }
      if(did) this.lastCall = Date.now();
    }catch(e){
      console.warn('[Gem]', e.message);
      this.lastCall = Date.now();
    }finally{ this.busy = false; }
  },

  /* 저장 직후 키가 실제로 통하는지 한 번 찔러본다.
     여기서 실패하면 소식통에 글을 쓰기 전에 원인을 알 수 있다. */
  async selftest(){
    try{
      const d = await this.json(this.cfg.kInv,
        '{"ok":true} 만 출력하라. 다른 말은 쓰지 마라.', { maxTokens: 40 });
      toast(d ? 'Gemini 연결 확인됨' : 'Gemini 응답이 비어 있습니다');
    }catch(e){
      console.warn('[Gem] 자체 점검 실패:', e.message);
      const code = (e.message.match(/^\d+/) || [''])[0];
      toast(
        code === '401' || code === '403' ? 'Gemini 키가 거부됐습니다 — API key 를 새로 발급하세요'
      : code === '404' ? `모델 이름이 틀렸습니다 — ${this.cfg.model} 를 확인하세요`
      : code === '429' ? '쿼터 초과 — 잠시 뒤 다시 시도됩니다'
      : 'Gemini 연결 실패 — 콘솔의 [Gem] 로그를 확인하세요');
    }
  },

  /* ── 설정 UI ─────────────────────────────────────────── */
  panel(){
    const c = this.cfg;
    openModal('Gemini 설정', `
      <p style="font-size:11px;color:var(--ink-dim);line-height:1.7">
        <b>관리자 창에서만</b> Gemini 를 호출합니다. 친구들은 키를 넣을
        필요가 없고, 판정 결과만 Firestore 로 받아봅니다.<br><br>
        키는 <b>이 브라우저에만</b> 저장됩니다. 저장소에 올라가지 않으니
        public repo 여도 안전합니다. 다른 기기에서 관리자로 접속하면
        거기서 한 번 더 넣어야 합니다.</p>
      <div class="fld"><label>투자자 조종 키 (임팩트 판정)</label>
        <input id="g_i" type="password" value="${c.kInv||''}" placeholder="AIza… 또는 AQ.…"></div>
      <div class="fld"><label>매크로 키 (국가 소식 검색 · 비워두면 위 키 사용)</label>
        <input id="g_a" type="password" value="${c.kAud||''}" placeholder="비우면 위 키를 함께 씁니다"></div>
      <div class="fld"><label>모델</label>
        <input id="g_m" value="${c.model}"></div>
      <p style="font-size:11px;color:var(--ink-dim);line-height:1.7">
        오늘 <b class="mono">${this.today()}</b> / ${DAY_CAP}회 사용 (무료 한도 250).
        1분에 1콜로 제한하고, 임팩트 판정은 8건씩 묶어 보냅니다.
        감사는 30분, 국가 소식은 3시간 간격입니다.</p>`,
    () => {
      c.kInv = modal.querySelector('#g_i').value.trim();
      c.kAud = modal.querySelector('#g_a').value.trim();
      c.model = modal.querySelector('#g_m').value.trim() || 'gemini-2.5-flash';
      this.dead = false; this.lastCall = 0; this.backoff = 0; this._capped = false; this.save();
      toast(c.kInv ? 'Gemini 활성화' : 'Gemini 비활성 — 로컬 채점으로 동작합니다');
      window.renderGemBadge();
      if(c.kInv) this.selftest();
    }, '저장');
  }
};

window.Gem = Gem;          // index.html 이 window.Gem 으로 존재를 확인한다
Gem.load();
setInterval(() => Gem.pump(), 3000);
