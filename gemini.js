/* ═══════════════════════════════════════════════════════════════
   gemini.js — 소식통 AI 계층
   ───────────────────────────────────────────────────────────────
   설계 원칙 세 가지:
   1. 키는 코드에 없다. 브라우저 localStorage에만 있다.
   2. 전역 스케줄러가 15초에 최대 1콜. 무료 티어 RPM을 절대 안 넘는다.
   3. Gemini는 숫자만 뱉는다. 10만 명 시뮬레이션은 로컬이 한다.
   ═══════════════════════════════════════════════════════════════ */

const Gem = {
  cfg: {},
  calls: 0,
  lastCall: 0,
  jobs: { macroAt: 0, auditAt: 0 },
  dead: false,

  /* ── 설정 ────────────────────────────────────────────── */
  load(){
    try{ this.cfg = JSON.parse(localStorage.getItem('sosiktong.gem')) || {}; }
    catch(e){ this.cfg = {}; }
    this.cfg.model = this.cfg.model || 'gemini-2.5-flash';
    return this.cfg;
  },
  save(){ localStorage.setItem('sosiktong.gem', JSON.stringify(this.cfg)); },
  ready(){ return !!(this.cfg.kInv && !this.dead); },

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
        this.lastCall = Date.now() + 45000;   // 쿼터 초과 시 45초 물러선다
      }
      throw new Error(`${r.status} ${t.slice(0,160)}`);
    }
    this.calls++;
    const d = await r.json();
    return (d.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();
  },

  /* JSON만 받아내는 래퍼. 코드펜스·설명문 다 벗겨낸다. */
  async json(key, prompt, { grounding=false, maxTokens=700 } = {}){
    const body = {
      contents: [{ role:'user', parts:[{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: maxTokens }
    };
    // grounding 을 켜면 responseMimeType 을 못 쓴다 → 텍스트로 받아 직접 판다
    if(grounding) body.tools = [{ google_search: {} }];
    else body.generationConfig.responseMimeType = 'application/json';

    const raw = await this.raw(key, body);
    const cut = raw.replace(/```json|```/g, '').trim();
    const s = cut.indexOf('{'), a = cut.indexOf('[');
    const st = (a >= 0 && (a < s || s < 0)) ? a : s;
    const en = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
    if(st < 0 || en < st) throw new Error('JSON 파싱 실패: ' + cut.slice(0,120));
    return JSON.parse(cut.slice(st, en+1));
  },

  /* ── 1) 뉴스 임팩트 판정 (배치) ───────────────────────
     점수 안 매겨진 뉴스를 최대 8건 모아 한 콜로 처리한다. */
  async scoreBatch(){
    const pend = S.news.filter(n => n.pending).slice(0, 8);
    if(!pend.length) return false;

    const feed = pend.map(n => {
      const co = S.companies.find(c => c.id === n.cid);
      return JSON.stringify({
        id: n.id,
        co: co ? co.name : '?',
        sector: co ? co.desc.slice(0,40) : '',
        txt: (n.title + ' — ' + n.body).slice(0, 420)
      });
    }).join('\n');

    const prompt =
`너는 냉정한 시장 애널리스트다. 아래 기업 발표들을 읽고 JSON 배열만 출력한다.
각 원소: {"id":"입력id","impact":-1~1,"horizon":"short|mid|long","confidence":0~1,"volatility":0.5~3}

채점 원칙:
- impact 는 발표 주체의 자화자찬을 할인한 값이다.
- 구체적 수치·계약 상대·일정이 없는 형용사뿐인 발표는 |impact| 0.2 이하로 본다.
- 이미 시장이 알 법한 뻔한 내용은 0에 가깝게 준다.
- horizon 은 이 재료가 며칠짜리인지다. 신제품 출시는 short, 설비투자는 long.
- volatility 는 이 발표가 만들 변동성 배수다. 논란거리일수록 높다.

[발표]
${feed}`;

    const arr = await this.json(this.cfg.kInv, prompt, { maxTokens: 600 });
    (Array.isArray(arr) ? arr : []).forEach(v => window.applyScore(v.id, v));
    // 응답에 빠진 건 로컬 채점으로 메운다
    pend.forEach(n => { if(n.pending) window.applyScore(n.id, { impact: localScore(n.title+' '+n.body) }); });
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

  /* ── 3) 젬민이 — 허점 감사 ───────────────────────────
     이게 이 게임의 심장이다. found:false 를 반드시 허용한다.
     매번 기사를 쓰게 하면 노이즈가 되고 CEO 발표가 무의미해진다. */
  async audit(){
    const targets = S.news.filter(n => n.src === 'CEO' && !n.audited && !n.pending).slice(0, 5);
    if(!targets.length) return false;
    targets.forEach(n => n.audited = true);

    const macroCtx = S.news.filter(n => n.src === '매크로').slice(0, 6)
      .map(n => `- ${n.title}`).join('\n') || '- (수집된 국가 소식 없음)';

    const feed = targets.map(n => {
      const co = S.companies.find(c => c.id === n.cid);
      return JSON.stringify({
        cid: n.cid, co: co ? co.name : '?', country: co ? co.country : '',
        title: n.title, body: n.body.slice(0, 300)
      });
    }).join('\n');

    const prompt =
`너는 '젬민이', 기업 발표의 허점을 파는 탐사 기자다.
아래 CEO 발표들을 국가 소식·환율과 대조해, 모순되거나 근거 없이 낙관적인 건만 골라낸다.

규칙:
- 허점이 없으면 정확히 {"found":false} 만 출력한다. 억지로 만들지 않는다.
- 발표 하나가 명백히 과장됐을 때만 기사를 쓴다. 애매하면 found:false 다.
- 기사 body 에는 어떤 국가 소식·환율과 충돌하는지 반드시 명시한다. 3~4문장.

찾았으면:
{"found":true,"cid":"...","title":"기사 제목","body":"본문","impact":-1~-0.15}

[CEO 발표]
${feed}

[최근 국가 소식]
${macroCtx}
[현재 USD/KRW] ${S.fx.toFixed(1)}`;

    const d = await this.json(this.cfg.kAud || this.cfg.kInv, prompt, { maxTokens: 600 });
    if(d && d.found && d.cid){
      window.pushNews({
        cid: d.cid, src:'젬민이', by:'탐사보도',
        title: d.title, body: d.body,
        impact: clamp(d.impact ?? -0.4, -1, -0.15),
        horizon:'mid', confidence:.9, volatility:2.1
      });
      toast('젬민이가 기사를 올렸습니다');
    }
    return true;
  },

  /* ── 전역 스케줄러 ───────────────────────────────────
     15초에 최대 1콜. 우선순위: 임팩트 > 감사 > 매크로.
     이것만으로 시간당 최대 240콜, 실제로는 훨씬 적다. */
  async pump(){
    if(!this.ready() || this.busy) return;
    if(Date.now() - this.lastCall < 15000) return;
    this.busy = true;
    try{
      const now = Date.now();
      let did = await this.scoreBatch();
      if(!did && now > this.jobs.auditAt){
        did = await this.audit();
        if(did) this.jobs.auditAt = now + 10*60*1000;   // 10분
      }
      if(!did && now > this.jobs.macroAt){
        did = await this.macro();
        if(did) this.jobs.macroAt = now + 60*60*1000;   // 1시간
      }
      if(did) this.lastCall = Date.now();
    }catch(e){
      console.warn('[Gem]', e.message);
      this.lastCall = Date.now();
    }finally{ this.busy = false; }
  },

  /* ── 설정 UI ─────────────────────────────────────────── */
  panel(){
    const c = this.cfg;
    openModal('Gemini 설정', `
      <p style="font-size:11px;color:var(--ink-dim);line-height:1.7">
        키는 <b>이 브라우저에만</b> 저장됩니다. 저장소에 올라가지 않으니
        public repo 여도 안전합니다. 친구들은 각자 한 번씩 넣으면 됩니다.</p>
      <div class="fld"><label>투자자 조종 키 (임팩트 판정)</label>
        <input id="g_i" type="password" value="${c.kInv||''}" placeholder="AIza… 또는 AQ.…"></div>
      <div class="fld"><label>젬민이 키 (허점 발견 · 기사)</label>
        <input id="g_a" type="password" value="${c.kAud||''}" placeholder="비우면 위 키를 함께 씁니다"></div>
      <div class="fld"><label>모델</label>
        <input id="g_m" value="${c.model}"></div>
      <p style="font-size:11px;color:var(--ink-dim);line-height:1.7">
        이번 세션 호출 <b class="mono">${this.calls}</b>회.
        스케줄러가 15초당 1콜로 제한하고, 임팩트 판정은 8건씩 묶어 보냅니다.</p>`,
    () => {
      c.kInv = modal.querySelector('#g_i').value.trim();
      c.kAud = modal.querySelector('#g_a').value.trim();
      c.model = modal.querySelector('#g_m').value.trim() || 'gemini-2.5-flash';
      this.dead = false; this.save();
      toast(c.kInv ? 'Gemini 활성화' : 'Gemini 비활성 — 로컬 채점으로 동작합니다');
      window.renderGemBadge();
    }, '저장');
  }
};

window.Gem = Gem;          // index.html 이 window.Gem 으로 존재를 확인한다
Gem.load();
setInterval(() => Gem.pump(), 3000);
