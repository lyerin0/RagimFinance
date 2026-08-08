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
  getFirestore, doc, setDoc, updateDoc, deleteDoc, collection,
  onSnapshot, runTransaction, serverTimestamp, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const TAPE_MS  = 12000;   // 시세 방송 주기. 아래 '무료 한도' 주석 참고
const LEASE_MS = 15000;   // 호스트 임대 시간

const FB = {
  on:false, guest:true, uid:null, db:null,
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
    S.me.admin = false;          // 명부에 등재된 사람만 관리자가 된다

    // 내 이름을 사용자 명부에 올린다. 소유권 이전 대상 목록이 여기서 나온다.
    await setDoc(doc(this.db,'users',this.uid),
      { name:S.me.name, at:Date.now() }, { merge:true }).catch(()=>{});

    this.listen();
    setInterval(() => this.beat(), 4000);
    this.beat();
    console.info('[FB] 연결됨', this.uid.slice(0,6));
    toast('공유 세계에 접속했습니다');
  },

  /* ── 구독 ──────────────────────────────────────────── */
  listen(){
    // 기업 메타데이터
    onSnapshot(collection(this.db,'companies'), snap => {
      snap.docChanges().forEach(ch => {
        const d = ch.doc.data(), id = ch.doc.id;
        if(ch.type === 'removed'){
          S.companies = S.companies.filter(c => c.id !== id); return;
        }
        let co = S.companies.find(c => c.id === id);
        if(!co){
          // 처음 보는 기업 — 로컬에 껍데기를 만들고 시세는 tape 가 채운다
          co = { id, price:d.price0||50000, prev:d.price0||50000, fair:d.price0||50000,
                 mom:0, sent:[0,0,0,0,0,0], candles:[], cur:null, tick:0 };
          seed(co, 140);
          S.companies.push(co);
        }
        Object.assign(co, {
          name:d.name, ticker:d.ticker, img:d.img, desc:d.desc,
          country:d.country, shares:d.shares, owner:d.owner, ownerName:d.ownerName
        });
      });
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
          Object.assign(S.news[i], d, { id });
          if(!this.guest && was === null && d.impact !== null) fire(S.news[i]);
        } else {
          S.news.unshift({ ...d, id, fresh:true });
        }
      });
      S.news.sort((a,b) => b.ts - a.ts);
      renderNews();
    });

    // 사용자 명부 — 소유권을 넘길 상대를 여기서 고른다
    onSnapshot(collection(this.db,'users'), snap => {
      S.users = snap.docs.map(d => ({ id:d.id, name:d.data().name || '이름없음' }));
    });

    // 관리자 명단 — Firestore 의 world/config 문서가 유일한 근거다
    onSnapshot(doc(this.db,'world','config'), snap => {
      const list = (snap.exists() && snap.data().admins) || [];
      S.admins = list;
      const was = S.me.admin;
      S.me.admin = list.includes(this.uid);
      if(!was && S.me.admin) toast('관리자로 확인되었습니다');
    });

    // 시세 방송 — 게스트만 받아 적는다
    onSnapshot(doc(this.db,'world','tape'), snap => {
      if(!snap.exists() || !this.guest) return;
      const t = snap.data();
      S.fx = t.fx || S.fx;
      Object.entries(t.px || {}).forEach(([cid, v]) => {
        const co = S.companies.find(c => c.id === cid);
        if(!co) return;
        co.price = v.p; co.prev = v.prev; co.fair = v.f;
        if(v.k){ try{ co.candles = JSON.parse(v.k); }catch(e){} }
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
    const ref = doc(this.db,'world','lock');
    try{
      const mine = await runTransaction(this.db, async tx => {
        const s = await tx.get(ref);
        const now = Date.now();
        const d = s.exists() ? s.data() : null;
        const free = !d || !d.at || (now - d.at) > LEASE_MS;
        if(free || d.host === this.uid){
          tx.set(ref, { host:this.uid, at:now });
          return true;
        }
        return false;
      });
      const was = this.guest;
      this.guest = !mine;
      if(was !== this.guest){
        toast(mine ? '이 창이 호스트가 되었습니다 (시뮬레이션 담당)'
                   : '다른 사람이 호스트입니다 (시세 수신)');
        renderHostBadge();
      }
    }catch(e){ console.warn('[FB] lock', e.message); }
  },

  /* ── 시세 방송 (호스트만) ──────────────────────────────
     기업이 몇 개든 문서 하나에 담는다. 쓰기 1회로 전부 처리. */
  async pushTape(){
    if(!this.on || this.guest) return;
    if(Date.now() - this.tapeAt < TAPE_MS) return;
    this.tapeAt = Date.now();
    const px = {};
    S.companies.forEach(c => {
      px[c.id] = {
        p:+c.price.toFixed(2), prev:+c.prev.toFixed(2), f:+c.fair.toFixed(2),
        k: JSON.stringify(c.candles.slice(-160).map(b => [
             +b.o.toFixed(1), +b.h.toFixed(1), +b.l.toFixed(1), +b.c.toFixed(1), b.v|0
           ]))
      };
    });
    try{
      await setDoc(doc(this.db,'world','tape'),
        { px, fx:+S.fx.toFixed(2), at:Date.now() });
    }catch(e){ console.warn('[FB] tape', e.message); }
  },

  /* ── 쓰기 ─────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════
   무료 한도 계산 (Spark 플랜: 쓰기 2만/일, 읽기 5만/일)

   TAPE_MS = 12초  →  하루 7,200회 쓰기.        ✅ 여유
   구독자 5명       →  7,200 × 5 = 36,000 읽기.  ✅ 아슬하게 통과
   구독자 8명       →  57,600 읽기.              ❌ 초과

   친구가 6명 넘어가면 TAPE_MS 를 20000 으로 올리세요.
   차트가 20초마다 갱신되지만 한도는 넉넉해집니다.
   ═══════════════════════════════════════════════════════════════ */
