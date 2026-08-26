/* V17 Professional Hybrid Dictionary
 * Offline-first engine: Memory -> IndexedDB -> rich shard -> online enrichment.
 * Compatible with the existing dictionary modal (#dict-input / #dict-result).
 */
(function () {
  'use strict';
  const CFG = {
    version: 'v17-professional-1',
    shardBase: 'dictionary-50k/',
    manifest: 'dictionary-50k/manifest.json',
    dbName: 'EnglishDictionaryV17',
    store: 'entries',
    ttl: 1000 * 60 * 60 * 24 * 90,
    maxMemory: 250,
    apiTimeout: 4500
  };
  const mem = new Map();
  const shardMem = new Map();
  let requestSeq = 0;
  let dbPromise = null;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const letters = 'abcdefghijklmnopqrstuvwxyz';

  // Small high-frequency learner seed. The full offline engine can consume richer shard data.
  const SEED = {
    advice:{pos:[['noun',['lời khuyên','sự khuyên bảo']]],examples:[['He gave me some useful advice.','Anh ấy cho tôi một vài lời khuyên hữu ích.']],syn:['guidance','recommendation'],family:['advise','adviser','advisable']},
    advise:{pos:[['verb',['khuyên','tư vấn']]],examples:[['I advise you to study regularly.','Tôi khuyên bạn nên học thường xuyên.']],syn:['counsel','recommend'],family:['advice','adviser','advisable']},
    postponed:{head:'postpone',pos:[['verb',['hoãn','trì hoãn']]],examples:[['The meeting was postponed until Monday.','Cuộc họp đã được hoãn đến thứ Hai.']],syn:['delay','defer','put off'],family:['postpone','postponed','postponing']},
    postpone:{pos:[['verb',['hoãn','trì hoãn']]],examples:[['We decided to postpone the meeting.','Chúng tôi quyết định hoãn cuộc họp.']],syn:['delay','defer','put off'],family:['postponed','postponing']},
    work:{pos:[['noun',['công việc','việc làm','tác phẩm']],[ 'verb',['làm việc','hoạt động','vận hành']]],examples:[['I have a lot of work today.','Hôm nay tôi có rất nhiều việc.'],['This machine works well.','Chiếc máy này hoạt động tốt.']],syn:['job','labor','operate'],family:['worker','working','workplace']},
    beautiful:{pos:[['adjective',['đẹp','xinh đẹp']]],examples:[['She lives in a beautiful house.','Cô ấy sống trong một ngôi nhà đẹp.']],syn:['pretty','lovely','attractive'],family:['beauty','beautifully']},
    concentrate:{pos:[['verb',['tập trung','cô đặc']]],examples:[['Please concentrate on your work.','Hãy tập trung vào công việc của bạn.']],syn:['focus','attend'],family:['concentration']},
    small:{pos:[['adjective',['nhỏ','bé']]],examples:[['They live in a small house.','Họ sống trong một ngôi nhà nhỏ.']],syn:['little','tiny','minor'],family:['smaller','smallest']},
    children:{head:'child',pos:[['noun',['trẻ em','con cái']]],examples:[['The children are playing outside.','Bọn trẻ đang chơi bên ngoài.']],family:['child','childhood','childish']},
    child:{pos:[['noun',['đứa trẻ','con']]],examples:[['The child is reading a book.','Đứa trẻ đang đọc sách.']],family:['children','childhood','childish']},
    run:{pos:[['verb',['chạy','vận hành']],[ 'noun',['cuộc chạy','lượt chạy']]],examples:[['I run every morning.','Tôi chạy bộ mỗi sáng.'],['The machine is running.','Máy đang hoạt động.']],syn:['jog','operate'],family:['ran','running','runner']},
    ran:{head:'run',pos:[['verb',['đã chạy']]],examples:[['She ran home quickly.','Cô ấy chạy nhanh về nhà.']],family:['run','running','runner']},
    good:{pos:[['adjective',['tốt','giỏi']]],examples:[['She is a good student.','Cô ấy là một học sinh giỏi.']],syn:['fine','excellent','great'],family:['better','best','goodness']},
    better:{head:'good',pos:[['adjective',['tốt hơn','giỏi hơn']]],examples:[['This book is better than that one.','Cuốn sách này hay hơn cuốn kia.']],family:['good','best']},
    best:{head:'good',pos:[['adjective',['tốt nhất','giỏi nhất']]],examples:[['She is the best student in the class.','Cô ấy là học sinh giỏi nhất lớp.']],family:['good','better']},
    learn:{pos:[['verb',['học','học hỏi']]],examples:[['I learn English every day.','Tôi học tiếng Anh mỗi ngày.']],syn:['study','acquire'],family:['learner','learning']},
    study:{pos:[['verb',['học','nghiên cứu']],[ 'noun',['việc học','nghiên cứu']]],examples:[['I study English at home.','Tôi học tiếng Anh ở nhà.']],syn:['learn','research'],family:['student','studies','studied']},
    important:{pos:[['adjective',['quan trọng']]],examples:[['This is an important lesson.','Đây là một bài học quan trọng.']],syn:['significant','essential'],family:['importance']},
    understand:{pos:[['verb',['hiểu','thấu hiểu']]],examples:[['Do you understand the question?','Bạn có hiểu câu hỏi không?']],syn:['comprehend','realize'],family:['understanding','understood']},
    question:{pos:[['noun',['câu hỏi','vấn đề']],[ 'verb',['hỏi']]],examples:[['I have a question.','Tôi có một câu hỏi.']],syn:['query','inquiry'],family:['questioning']},
    answer:{pos:[['noun',['câu trả lời','đáp án']],[ 'verb',['trả lời']]],examples:[['Please answer the question.','Hãy trả lời câu hỏi.']],syn:['reply','respond'],family:['answered','answering']},
    computer:{pos:[['noun',['máy tính']]],examples:[['I use a computer every day.','Tôi dùng máy tính mỗi ngày.']],syn:['PC','machine'],family:['computing','computerized']},
    example:{pos:[['noun',['ví dụ','mẫu']]],examples:[['For example, this sentence is simple.','Ví dụ, câu này rất đơn giản.']],syn:['instance','sample'],family:['exemplify']},
    language:{pos:[['noun',['ngôn ngữ']]],examples:[['English is an international language.','Tiếng Anh là một ngôn ngữ quốc tế.']],family:['linguistic','languages']},
    english:{pos:[['noun',['tiếng Anh']],[ 'adjective',['thuộc tiếng Anh','Anh']]],examples:[['I am learning English.','Tôi đang học tiếng Anh.']],family:['English-speaking']}
  };

  function openDB(){
    if(!('indexedDB' in window)) return Promise.resolve(null);
    if(dbPromise) return dbPromise;
    dbPromise = new Promise(resolve=>{
      try{
        const req=indexedDB.open(CFG.dbName,1);
        req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(CFG.store)) db.createObjectStore(CFG.store,{keyPath:'key'}); };
        req.onsuccess=()=>resolve(req.result); req.onerror=()=>resolve(null);
      }catch(e){resolve(null)}
    });
    return dbPromise;
  }
  async function idbGet(key){ const db=await openDB(); if(!db)return null; return new Promise(r=>{try{const q=db.transaction(CFG.store,'readonly').objectStore(CFG.store).get(key);q.onsuccess=()=>r(q.result||null);q.onerror=()=>r(null)}catch(e){r(null)}})}
  async function idbSet(entry){ const db=await openDB(); if(!db)return; try{db.transaction(CFG.store,'readwrite').objectStore(CFG.store).put(entry)}catch(e){} }

  function seedEntry(word){ return SEED[norm(word)] || null; }
  function normalizeEntry(raw, key){
    if(!raw) return null;
    // Accept several likely shard schemas: object-map, array, or compact fields.
    let e=raw;
    if(typeof raw === 'string') return {word:key, vi:[raw]};
    if(raw.word && raw.word !== key) return raw;
    const out={word:key};
    out.head = raw.head || raw.lemma || raw.base || raw.root || '';
    out.ipa = raw.ipa || raw.IPA || raw.pronunciation || '';
    out.pos = raw.pos || raw.partOfSpeech || raw.part_of_speech || [];
    out.vi = raw.vi || raw.meanings_vi || raw.senses_vi || raw.meaning_vi || raw.translation || raw.translations || [];
    out.examples = raw.examples || raw.example || [];
    out.syn = raw.syn || raw.synonyms || [];
    out.ant = raw.ant || raw.antonyms || [];
    out.family = raw.family || raw.wordFamily || raw.word_family || [];
    if(raw.meanings && !out.vi.length) out.meanings=raw.meanings;
    if(raw.definitions && !out.vi.length) out.definitions=raw.definitions;
    return out;
  }
  async function loadShard(letter){
    if(shardMem.has(letter)) return shardMem.get(letter);
    try{
      const res=await fetch(CFG.shardBase+letter+'.json',{cache:'force-cache'});
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data=await res.json(); shardMem.set(letter,data); return data;
    }catch(e){ shardMem.set(letter,null); return null; }
  }
  function shardLookup(data,key){
    if(!data) return null;
    if(Array.isArray(data)) return normalizeEntry(data.find(x=>norm(x.word||x.w||x.headword||x.term)===key),key);
    if(data[key]) return normalizeEntry(data[key],key);
    if(data.words && data.words[key]) return normalizeEntry(data.words[key],key);
    return null;
  }
  async function offlineLookup(word){
    const key=norm(word); if(!key)return null;
    const direct=seedEntry(key); if(direct)return {...direct,word:key,source:'seed'};
    const letter=key[0];
    if(!letters.includes(letter)) return null;
    const data=await loadShard(letter);
    const raw=shardLookup(data,key);
    if(raw) return {...raw,word:key,source:'shard'};
    // Try a simple headword map for common inflections.
    const candidates=inflectionCandidates(key);
    for(const c of candidates){
      const s=seedEntry(c); if(s)return {...s,word:key,head:s.head||c,source:'seed-inflection'};
      const r=shardLookup(data,c); if(r)return {...r,word:key,head:r.head||c,source:'shard-inflection'};
    }
    return null;
  }
  const IRREG={ran:'run',gone:'go',went:'go',children:'child',men:'man',women:'woman',mice:'mouse',geese:'goose',better:'good',best:'good',worse:'bad',worst:'bad',teeth:'tooth',feet:'foot',people:'person',studies:'study',studied:'study',running:'run',ran:'run',done:'do',did:'do',was:'be',were:'be',been:'be',am:'be',is:'be',are:'be',had:'have',has:'have',having:'have',saw:'see',seen:'see',took:'take',taken:'take',gave:'give',given:'give'};
  function inflectionCandidates(w){
    const a=[]; if(IRREG[w]) a.push(IRREG[w]);
    if(w.endsWith('ies')&&w.length>4)a.push(w.slice(0,-3)+'y');
    if(w.endsWith('ied')&&w.length>4)a.push(w.slice(0,-3)+'y');
    if(w.endsWith('ing')&&w.length>5){a.push(w.slice(0,-3));a.push(w.slice(0,-3)+'e');}
    if(w.endsWith('ed')&&w.length>4){a.push(w.slice(0,-2));a.push(w.slice(0,-1));}
    if(w.endsWith('es')&&w.length>4)a.push(w.slice(0,-2));
    if(w.endsWith('s')&&w.length>3)a.push(w.slice(0,-1));
    return [...new Set(a.filter(Boolean))];
  }
  function normalizeApi(data, requested){
    if(!Array.isArray(data)||!data.length)return null;
    const entries=[];
    for(const e of data){
      const pos=(e.meanings||[]).map(m=>({partOfSpeech:m.partOfSpeech||'',definitions:(m.definitions||[]).slice(0,6).map(d=>({en:d.definition||'',example:d.example||'',syn:d.synonyms||[]}))}));
      const phon=(e.phonetics||[]).map(p=>p.text).filter(Boolean);
      entries.push({word:e.word||requested,ipa:phon[0]||e.phonetic||'',pos,source:'online'});
    }
    return {word:requested,head:entries[0]?.word||requested,ipa:entries[0]?.ipa||'',apiEntries:entries,source:'online'};
  }
  async function fetchJSON(url){
    const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),CFG.apiTimeout);
    try{const r=await fetch(url,{signal:ctl.signal,cache:'force-cache'}); if(!r.ok)throw new Error('HTTP '+r.status); return await r.json();}finally{clearTimeout(t)}
  }
  async function onlineEnrich(word){
    const [dict,vi] = await Promise.allSettled([
      fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(word)),
      fetchJSON('https://api.mymemory.translated.net/get?q='+encodeURIComponent(word)+'&langpair=en|vi')
    ]);
    const out={word,source:'online'};
    if(dict.status==='fulfilled') Object.assign(out,normalizeApi(dict.value,word)||{});
    if(vi.status==='fulfilled') out.vi=[vi.value?.responseData?.translatedText].filter(Boolean);
    return (out.apiEntries?.length || out.vi?.length) ? out : null;
  }
  function merge(a,b){
    if(!a)return b; if(!b)return a; const o={...a,...b};
    o.word=a.word||b.word; o.head=b.head||a.head||''; o.ipa=a.ipa||b.ipa||''; o.pos=b.pos?.length?a.pos?.length?[...a.pos,...b.pos]:b.pos:a.pos||[];
    o.vi=b.vi?.length?b.vi:a.vi||[]; o.examples=a.examples||[]; o.syn=a.syn||[]; o.family=a.family||[]; return o;
  }
  function render(entry, requested){
    const head=entry.head||requested; let html=`<div class="v17-card"><div class="v17-head"><b>${esc(requested)}</b><span class="v17-badge">⚡ OFFLINE-FIRST</span><button class="pronunciation-btn listen" type="button" onclick="speakWord('${esc(requested)}')">🔊 Nghe</button><button class="pronunciation-btn check" type="button" onclick="startPronunciationCheck('${esc(requested)}')">🎙️ Kiểm tra</button></div>`;
    if(head!==requested) html+=`<div class="v17-headword">↳ Từ gốc: <button type="button" onclick="window.lookupWord('${esc(head)}')">${esc(head)}</button></div>`;
    if(entry.ipa) html+=`<div class="v17-ipa">🔤 IPA: <span>${esc(entry.ipa)}</span></div>`;
    if(entry.vi?.length) html+=`<div class="v17-vi"><b>🇻🇳 Nghĩa tiếng Việt</b><div>${entry.vi.map(esc).join('; ')}</div></div>`;
    const pos=entry.pos||[];
    if(pos.length){ html+=`<div class="v17-section"><h4>📚 Từ loại & định nghĩa</h4>`; for(const p of pos){
      if(p.partOfSpeech){html+=`<div class="v17-pos"><b>${esc(p.partOfSpeech)}</b>`; if(p.definitions){for(const d of p.definitions.slice(0,5)){html+=`<div>• ${esc(d.en||d.definition||'')}`; if(d.example)html+=`<div class="v17-example">“${esc(d.example)}”</div>`; html+='</div>'}} html+='</div>'}
      else if(Array.isArray(p)) html+=`<div class="v17-pos"><b>${esc(p[0])}</b><div>${(p[1]||[]).map(esc).join('; ')}</div></div>`;
    } html+='</div>'}
    if(entry.examples?.length) html+=`<div class="v17-section"><h4>💬 Ví dụ</h4>${entry.examples.slice(0,5).map(x=>Array.isArray(x)?`<div class="v17-example"><b>${esc(x[0])}</b><br>${esc(x[1]||'')}</div>`:`<div class="v17-example">${esc(x)}</div>`).join('')}</div>`;
    if(entry.syn?.length) html+=`<div class="v17-links"><b>🔗 Đồng nghĩa:</b> ${entry.syn.slice(0,20).map(esc).join(', ')}</div>`;
    if(entry.ant?.length) html+=`<div class="v17-links"><b>↔️ Trái nghĩa:</b> ${entry.ant.slice(0,20).map(esc).join(', ')}</div>`;
    if(entry.family?.length) html+=`<div class="v17-family"><b>🌿 Word Family:</b> ${entry.family.slice(0,20).map(w=>`<button type="button" onclick="window.lookupWord('${esc(w)}')">${esc(w)}</button>`).join(' ')}</div>`;
    html+=`<div class="v17-source">Nguồn: ${entry.source==='online'?'Online + cache':'Offline dictionary'} · V17</div></div>`; return html;
  }
  function style(){ if(document.getElementById('v17-style'))return; const s=document.createElement('style');s.id='v17-style';s.textContent=`.v17-card{background:#eef7ff;border:1px solid #b9dcff;border-radius:10px;padding:14px;line-height:1.55}.v17-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.v17-head>b{font-size:1.7em;color:#540606}.v17-badge{background:#dff1ff;color:#145a86;padding:4px 9px;border-radius:999px;font-size:.82em}.v17-headword{margin:8px 0;color:#555}.v17-headword button,.v17-family button{border:1px solid #bbb;background:#fff;border-radius:999px;padding:3px 8px;cursor:pointer}.v17-ipa{font-size:1.15em;margin:8px 0}.v17-ipa span{font-family:monospace}.v17-vi{background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:10px;margin:8px 0;color:#1b5e20}.v17-section{margin-top:10px}.v17-section h4{margin:0 0 6px}.v17-pos{background:#fff;border-left:4px solid #007bff;border-radius:6px;padding:8px 10px;margin:6px 0}.v17-example{margin:4px 0 0 10px;color:#555;font-style:italic}.v17-links{margin-top:8px;color:#5d3b8c}.v17-family{margin-top:10px;background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:9px}.v17-source{margin-top:10px;color:#777;font-size:.8em}.v17-loading{padding:12px;text-align:center;color:#555}`;document.head.appendChild(s)}
  async function cacheGet(key){ if(mem.has(key))return mem.get(key); const x=await idbGet(key); if(x&&Date.now()-x.savedAt<CFG.ttl){mem.set(key,x.html);return x.html} return null }
  async function cacheSet(key,html){mem.set(key,html);if(mem.size>CFG.maxMemory)mem.delete(mem.keys().next().value);await idbSet({key,html,savedAt:Date.now(),version:CFG.version})}

  window.lookupWord = async function(requestedWord=''){
    style(); const input=document.getElementById('dict-input'), box=document.getElementById('dict-result'); if(!input||!box)return;
    const typed=String(requestedWord||input.value||'').trim(); if(!typed)return; input.value=typed; const key=norm(typed); const id=++requestSeq;
    const cached=await cacheGet(key); if(id!==requestSeq)return; if(cached){box.innerHTML=cached; return;}
    box.innerHTML='<div class="v17-loading">⚡ <b>Tra Offline trước...</b></div>';
    let offline=await offlineLookup(key); if(id!==requestSeq)return;
    if(offline){box.innerHTML=render(offline,key);}
    else {box.innerHTML='<div class="v17-loading">🔎 Chưa có trong shard Offline. Đang bổ sung Online...</div>';}
    // Always enrich online in background when available; never block offline rendering.
    if(navigator.onLine!==false){
      const online=await onlineEnrich(offline?.head||key); if(id!==requestSeq)return;
      if(online){const merged=merge(offline,online);box.innerHTML=render(merged,key);await cacheSet(key,box.innerHTML);}
      else if(offline){await cacheSet(key,box.innerHTML);}
      else box.innerHTML='<div style="color:#b00020;padding:10px">Không tìm thấy từ hoặc hiện không có dữ liệu mạng.</div>';
    } else if(offline){await cacheSet(key,box.innerHTML);}
    try{if(typeof dictV11RememberRecent==='function')dictV11RememberRecent(key); if(typeof dictV11RenderRecent==='function')dictV11RenderRecent()}catch(e){}
  };

  window.V17Dictionary={version:CFG.version,lookup:offlineLookup,seed:SEED};
  console.info('V17 Professional Dictionary loaded');
})();
