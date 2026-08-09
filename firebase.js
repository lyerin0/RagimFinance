/* ═══════════════════════════════════════════════════════════════
   firebase.js — 공유 세계
   ───────────────────────────────────────────────────────────────
   무엇을 공유하나:
     companies  기업 메타데이터 (이름·로고·설명·소유주)
     news       소식통 전체
     world/tape 시세 방송 — 모든 기업의 가격·캔들이 문서 하나에

   무엇을 공유 안 하나 (일부러):
     내 현금·포지션. 친구끼리 하는 게임이라 각자 로컬에 둔다.
     이걸 서버에 두려면 Cloud Functions 로 잔고를 막아야 하는데
     그건 규모가 커지면 그때 하면 된다.

   호스트 개념:
     10만 명 엔진을 모두가 각자 돌리면 가격이 갈라진다.
     그래서 한 명만 돌리고 결과를 방송한다. 호스트가 나가면
     15초 뒤 남은 사람 중 하나가 자동으로 이어받는다.
   ═══════════════════════════════════════════════════════════════ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  onSnapshot, runTransaction, serverTimestamp, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const FB_BUILD = '2026-08-10a';
console.log('%c[FB] firebase.js build ' + FB_BUILD, 'color:#3ecfcf;font-weight:bold');

const TAPE_MS  = 6000;    // 시세 방송 주기. 아래 '무료 한도' 주석 참고
const LEASE_MS = 15000;   // 호스트 임대 시간

const FB = {
  on:false, guest:true, uid:null, db:null, want:false, hydrated:false,
  hostSince:0, tapeAt:0,

  async start(){
    const cfg = window.FIREBASE_CONFIG;
    if(!cfg || !cfg.apiKey){ console.info('[FB] 설정 없음 — 로컬 모드'); return; }

    const app  = initializeApp(cfg);
    this.db    = getFirestore(app);
    const auth = getAuth(app);

    await signInAnonymously(auth).catch(e => {
      toast('Firebase 익명 로그인 실패 — Authentication 에서 익명을 켜세요');
      throw e;
    });
    this.uid = auth.currentUser.uid;
    S.me.id  = this.uid;
    this.on  = true;
    this.syncAdmin(true);

    /* 지갑과 포지션을 서버에서 불러온다.
       예전엔 이게 로컬에만 있어서, 가격은 서버 기준인데 진입가는
       내 브라우저 기준이 되어 평가손익 부호가 뒤집혔다. */
    try{
      const mine = await getDoc(doc(this.db,'users',this.uid));
      if(mine.exists()){
        const d = mine.data();
        if(typeof d.cash === 'number') S.me.cash = d.cash;
        if(Array.isArray(d.positions)) S.positions = d.positions;
        if(d.name) S.me.name = d.name;
      }
    }catch(e){ console.warn('[FB] 지갑 로드', e.message); }

    await setDoc(doc(this.db,'users',this.uid), {
      name:S.me.name, cash:S.me.cash, positions:S.positions, at:Date.now()
    }, { merge:true }).catch(()=>{});
    renderWallet(); renderPos();

    this.listen();
    setInterval(() => this.beat(), 4000);
    this.beat();
    console.info('[FB] 연결됨', this.uid.slice(0,6));
    toast('공유 세계에 접속했습니다');
  },

  /* 관리자 판별. 화면을 여는 근거일 뿐이고, 실제 차단은
     firestore.rules 의 같은 목록이 서버에서 한다.
     beat() 에서 매번 다시 확인하므로 어떤 이유로 풀려도 복구된다. */
  syncAdmin(announce){
    S.admins = window.ADMIN_UIDS || [];
    const was = S.me.admin;
    S.me.admin = S.admins.includes(this.uid);
    if(S.me.admin && (announce || !was)){
      setTimeout(()=>toast('관리자로 접속했습니다'), 600);
    }
    if(!S.me.admin && announce){
      console.warn('[FB] 관리자 아님. 내 ID:', this.uid,
                   '/ ADMIN_UIDS:', S.admins);
    }
    return S.me.admin;
  },

  /* ── 구독 ──────────────────────────────────────────── */
  listen(){
    // 기업 메타데이터
    onSnapshot(collection(this.db,'companies'), snap => {
      snap.docChanges().forEach(ch => {
        const d = ch.doc.data(), id = ch.doc.id;
        if(ch.type === 'removed'){
          // 상장폐지된 종목의 포지션은 마지막 가격으로 청산해 돌려준다
          const co = S.companies.find(c => c.id === id);
          const mine = S.positions.filter(p => p.cid === id);
          if(mine.length){
            mine.forEach(p => { S.me.cash += p.margin + pnlOf(p, co); });
            S.positions = S.positions.filter(p => p.cid !== id);
            this.saveMe(); renderPos(); renderWallet();
            toast('상장폐지된 종목의 포지션이 청산되었습니다');
          }
          S.companies = S.companies.filter(c => c.id !== id);
          S.news = S.news.filter(n => n.cid !== id);
          if(S.sel && S.sel.id === id) S.sel = S.companies[0] || null;
          renderNews();
          return;
        }
        let co = S.companies.find(c => c.id === id);
        if(!co){
          /* 처음 보는 기업. 여기서 seed() 로 가짜 과거를 만들면 안 된다 —
             새로고침할 때마다 다른 난수 과거가 생겨서 차트가 매번 바뀌고,
             사람마다 다른 그림을 보게 된다. 캔들은 tape 방송으로만 채운다. */
          const p0 = d.price0 || 50000;
          co = { id, price:p0, prev:p0, fair:p0,
                 mom:0, sent:[0,0,0,0,0,0], candles:[], cur:null, tick:0 };
          S.companies.push(co);
        }
        Object.assign(co, {
          name:d.name, ticker:d.ticker, img:d.img, desc:d.desc,
          country:d.country, shares:d.shares, owner:d.owner, ownerName:d.ownerName
        });
      });
      /* 기업이 도착한 뒤에 로컬 이력을 붙인다. 부팅 시점에는 목록이
         비어 있어서 복원이 헛돌기 때문이다. 캔들이 이미 있으면 건너뛴다. */
      loadCandles();
      renderCos();
      if(!S.sel && S.companies.length) select(S.companies[0].id);
    });

    // 소식통
    onSnapshot(query(collection(this.db,'news'), orderBy('ts','desc'), limit(80)), snap => {
      snap.docChanges().forEach(ch => {
        const d = ch.doc.data(), id = ch.doc.id;
        const i = S.news.findIndex(n => n.id === id);
        if(ch.type === 'removed'){ if(i>=0) S.news.splice(i,1); return; }
        if(i >= 0){
          // 판정 결과가 도착한 경우 — 가격 반영은 호스트만 한다
          const was = S.news[i].impact;
          const fired = S.news[i].fired;
          Object.assign(S.news[i], d, { id, fired });
          if(!this.guest && was === null && d.impact !== null) fire(S.news[i]);
        } else {
          const n = { ...d, id, fresh:true };
          S.news.unshift(n);
          if(!this.guest && n.impact !== null && n.impact !== undefined) fire(n);
        }
      });
      S.news.sort((a,b) => b.ts - a.ts);
      renderNews();
    });

    // 사용자 명부 — 소유권을 넘길 상대를 여기서 고른다
    onSnapshot(collection(this.db,'users'), snap => {
      S.users = snap.docs.map(d => ({ id:d.id, name:d.data().name || '이름없음' }));
    });

    // 시세 방송 — 게스트만 받아 적는다
    /* 비상 개폐는 모두가 같은 값을 봐야 한다. 관리자만 쓰고 전원이 읽는다. */
    onSnapshot(doc(this.db,'world','rate'), snap => {
      const d = snap.data();
      if(d && typeof d.v === 'number'){ RATE.v = d.v; renderRate(); }
    });

    onSnapshot(doc(this.db,'world','market'), snap => {
      const d = snap.data();
      MK.ov = (d && d.mode && Date.now() < d.until) ? { mode:d.mode, until:d.until } : null;
      MK.sync(true);
    });

    onSnapshot(doc(this.db,'world','tape'), snap => {
      if(!snap.exists()) return;
      const t = snap.data();

      /* 호스트가 예전 빌드면 시세는 그쪽 규칙으로 계산된다.
         내 파일을 아무리 새로 올려도 화면은 안 바뀌므로 반드시 알려야 한다. */
      if(t.b && t.b !== BUILD) warnStale(t.b);
      else clearStale();

      /* 호스트도 부팅 직후 한 번은 방송을 받아 캔들을 이어붙인다.
         호스트는 평소 방송을 무시하는데(자기 계산이 덮이면 안 되므로),
         그래서 새로고침하면 빈 차트에서 다시 시작하는 문제가 있었다.
         기업 목록이 아직 안 왔으면 다음 방송에서 다시 시도한다. */
      const hydrate = !this.hydrated;
      if(!this.guest && !hydrate) return;
      if(hydrate && S.companies.length) this.hydrated = true;

      // 지수는 제수까지 같이 받아야 모두가 같은 값을 본다
      if(t.nd) NOSPI.div = t.nd;
      if(t.nk){ try{
        NOSPI.candles = JSON.parse(t.nk).map(b=>({o:b[0],h:b[1],l:b[2],c:b[3],v:0}));
        NOSPI.prev = NOSPI.prevClose();
      }catch(e){} }

      S.fx = t.fx || S.fx;
      Object.entries(t.px || {}).forEach(([cid, v]) => {
        const co = S.companies.find(c => c.id === cid);
        if(!co) return;
        co.price = v.p; co.prev = v.prev; co.fair = v.f;
        if(v.k){
          try{
            // 방송은 [o,h,l,c,v] 배열로 압축돼서 온다
            const rows = JSON.parse(v.k);
            if(rows.length) co.candles = rows.map(r =>
              Array.isArray(r) ? {o:r[0],h:r[1],l:r[2],c:r[3],v:r[4]} : r);
          }catch(e){}
        }
        co.cur = null; co.tick = 0;
      });
      if(S.sel){ renderHead(); paint(); }
    });
  },

  /* ── 호스트 선출 ───────────────────────────────────────
     Firestore 트랜잭션으로 임대권을 잡는다. 임대가 만료됐으면
     아무나 가져갈 수 있고, 잡은 사람이 시뮬레이션을 돌린다. */
  async beat(){
    if(!this.on) return;
    this.syncAdmin(false);
    const ref = doc(this.db,'world','lock');
    try{
      const mine = await runTransaction(this.db, async tx => {
        const s = await tx.get(ref);
        const now = Date.now();
        const d = s.exists() ? s.data() : null;
        /* Gemini 호출은 관리자이면서 호스트인 창에서만 일어난다.
           그래서 일반 친구가 호스트를 쥐고 있으면 AI 가 통째로 멈춘다.
           예전에는 임대가 만료될 때까지 기다렸는데, 상대가 계속
           갱신하면 관리자가 영영 호스트가 못 돼서 AI 가 죽어 있었다.
           이제 관리자는 비관리자 호스트를 즉시 넘겨받는다. */
        const free  = !d || !d.at || (now - d.at) > LEASE_MS * 2;
        const seize = S.me.admin && d && d.host !== this.uid && !d.adm;
        if(free || seize || d.host === this.uid || this.want){
          this.want = false;
          tx.set(ref, { host:this.uid, at:now, adm: !!S.me.admin });
          return true;
        }
        return false;
      });
      const was = this.guest;
      this.guest = !mine;
      if(mine && !this.caught) this.doCatchUp();
      if(was !== this.guest){
        toast(mine ? '이 창이 호스트가 되었습니다 (시뮬레이션·AI 담당)'
                   : '다른 사람이 호스트입니다 (시세 수신)');
        renderHostBadge();
      }
    }catch(e){
      // 창을 여러 개 띄우면 임대권 경합으로 failed-precondition 이 난다.
      // 다음 beat 에서 다시 시도하면 되므로 조용히 넘긴다.
      if(!/failed-precondition|aborted/i.test(e.message))
        console.warn('[FB] lock', e.message);
    }
  },

  /* 아무도 없던 동안의 장세를 따라잡는다.
     tape 문서의 마지막 기록 시각과 지금을 비교해 그만큼 몰아서 돌린다.
     정적 호스팅에는 서버가 없으므로 이게 '꺼도 돌아간다'의 현실적인 답이다. */
  async doCatchUp(){
    if(this.caught) return;
    this.caught = true;
    try{
      const s = await getDoc(doc(this.db,'world','tape'));
      if(!s.exists() || !s.data().at) return;
      const gap = Date.now() - s.data().at;
      // 새로고침 정도의 짧은 공백까지 따라잡으면 차트가 계속 흔들린다
      if(gap > 60000){
        const bars = window.catchUp(gap);
        if(bars) this.tapeAt = 0;      // 결과를 곧바로 방송한다
      }
    }catch(e){ console.warn('[FB] catchUp', e.message); }
  },

  /* ── 시세 방송 (호스트만) ──────────────────────────────
     기업이 몇 개든 문서 하나에 담는다. 쓰기 1회로 전부 처리. */
  async pushTape(){
    if(!this.on || this.guest) return;
    // 호스트인데 캔들이 비어 있으면(첫 상장 직후) 출발점을 한 번만 만든다
    S.companies.forEach(c => { if(!c.candles.length) seed(c, 60); });
    if(Date.now() - this.tapeAt < TAPE_MS) return;
    this.tapeAt = Date.now();
    const px = {};
    S.companies.forEach(c => {
      px[c.id] = {
        p:+c.price.toFixed(2), prev:+c.prev.toFixed(2), f:+c.fair.toFixed(2),
        k: JSON.stringify(c.candles.slice(-260).map(b => [
             +b.o.toFixed(1), +b.h.toFixed(1), +b.l.toFixed(1), +b.c.toFixed(1), b.v|0
           ]))
      };
    });
    try{
      await setDoc(doc(this.db,'world','tape'),
        { px, fx:+S.fx.toFixed(2), at:Date.now(), b:BUILD,
          nd:+NOSPI.div.toFixed(4),          // 제수를 같이 실어 지수를 일치시킨다
          nk:JSON.stringify(NOSPI.candles.slice(-260).map(b=>[
               +b.o.toFixed(2),+b.h.toFixed(2),+b.l.toFixed(2),+b.c.toFixed(2)])) });
    }catch(e){ console.warn('[FB] tape', e.message); }
  },

  /* ── 쓰기 ─────────────────────────────────────────────── */
  async saveMe(){
    if(!this.on) return;
    await setDoc(doc(this.db,'users',this.uid), {
      name:S.me.name, cash:S.me.cash, positions:S.positions, at:Date.now()
    }, { merge:true }).catch(e => console.warn('[FB] 지갑 저장', e.message));
  },
  async setMyName(name){
    if(!this.on) return;
    await setDoc(doc(this.db,'users',this.uid), { name, at:Date.now() }, { merge:true });
  },
  async addCompany(co){
    if(!this.on) return;
    await setDoc(doc(this.db,'companies',co.id), {
      name:co.name, ticker:co.ticker, img:co.img, desc:co.desc,
      country:co.country, shares:co.shares, price0:co.price,
      owner:co.owner, ownerName:co.ownerName, at:Date.now()
    });
  },
  async editCompany(co){
    if(!this.on) return;
    await updateDoc(doc(this.db,'companies',co.id), {
      name:co.name, ticker:co.ticker, img:co.img, desc:co.desc,
      country:co.country, board:co.board||'NONEX', warn:co.warn||0
    }).catch(e => toast('수정 실패 — 소유주만 고칠 수 있습니다'));
  },

  /* 상장폐지. 기업 문서와 관련 기사를 지우고, 방송에서도 뺀다.
     다른 사람의 포지션은 각자 users 문서에 있어서 여기서 못 지운다.
     대신 각 클라이언트가 없는 기업의 포지션을 스스로 정리한다. */
  async delistCompany(cid){
    if(!this.on) return;
    try{
      const gone = S.news.filter(n=>n.cid===cid).map(n=>n.id);
      await deleteDoc(doc(this.db,'companies',cid));
      await Promise.all(gone.map(id => deleteDoc(doc(this.db,'news',id)).catch(()=>{})));
      this.tapeAt = 0;                      // 방송을 즉시 갱신해 목록에서 뺀다
    }catch(e){ toast('상장폐지 실패 — 관리자만 가능합니다'); }
  },

  async setMarket(ov){
    if(!this.on) return;
    await setDoc(doc(this.db,'world','market'),
      ov ? { mode:ov.mode, until:ov.until, by:this.uid } : { mode:null, until:0, by:this.uid }
    ).catch(e => toast('장 상태 저장 실패 — 관리자만 가능합니다'));
  },

  async setRate(v){
    if(!this.on) return;
    await setDoc(doc(this.db,'world','rate'), { v, by:this.uid, at:Date.now() })
      .catch(() => toast('기준금리 저장 실패 — 관리자만 가능합니다'));
  },

  async setOwner(cid, owner, ownerName){
    if(!this.on) return;
    await updateDoc(doc(this.db,'companies',cid), { owner, ownerName });
  },
  async addNews(n){
    if(!this.on) return;
    const { fresh, ...rest } = n;
    await setDoc(doc(this.db,'news',n.id), rest);
  },
  async patchNews(id, patch){
    if(!this.on) return;
    await updateDoc(doc(this.db,'news',id), patch).catch(()=>{});
  }
};

window.FB = FB;
window.renderHostBadge = () => {
  const e = document.getElementById('hostDot');
  if(!e) return;
  e.textContent = !FB.on ? '로컬' : (FB.guest ? '수신' : '호스트');
  e.style.color = !FB.on ? 'var(--ink-dim)' : (FB.guest ? 'var(--cyan)' : 'var(--amber)');
};

FB.start().then(renderHostBadge).catch(e => console.warn('[FB]', e.message));
setInterval(() => FB.pushTape(), 2000);
setInterval(() => { if(FB.on) FB.saveMe(); }, 45000);   // 지갑 보험 저장

/* ═══════════════════════════════════════════════════════════════
   무료 한도 계산 (Spark 플랜: 쓰기 2만/일, 읽기 5만/일)

   TAPE_MS = 6초  →  하루 14,400회 쓰기.        ✅ 한도 2만 안쪽
   구독자 3명      →  14,400 × 3 = 43,200 읽기.  ✅ 한도 5만 안쪽
   구독자 4명      →  57,600 읽기.               ❌ 초과

   친구가 4명 이상 되면 TAPE_MS 를 12000 으로 되돌리세요.
   쓰기 7,200 · 읽기 36,000 이라 5명까지 버팁니다.
   (하루 종일 켜뒀을 때 기준이라 실제로는 더 여유가 있습니다)
   ═══════════════════════════════════════════════════════════════ */
